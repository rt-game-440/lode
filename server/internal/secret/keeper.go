package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Cipher 加解密 API key：*Box（固定的主密钥）和 *Keeper（可以锁定）都实现它。
type Cipher interface {
	Enabled() bool
	Seal(plain, aad string) (string, error)
	Open(sealed, aad string) (string, error)
}

// Mode 是主密钥的保管方式。
type Mode string

const (
	ModeEnv     Mode = "env"     // 环境变量 LODE_SECRET_KEY
	ModeFile    Mode = "file"    // 数据目录里的 secret.key
	ModePasskey Mode = "passkey" // 用通行密钥的 PRF 输出包裹，解开后只保存在内存里（#29）
)

// 通行密钥模式下 OpenKeeper 返回的来源。
const (
	SourcePasskey      Source = "passkey"       // 通行密钥保护，启动后处于锁定状态
	SourcePasskeyStale Source = "passkey-stale" // 同上，并且删除了残留的 secret.key
)

// ErrLocked 表示主密钥由通行密钥保护且尚未解锁。文案直接展示给用户。
var ErrLocked = errors.New("已保存的 API key 已锁定：服务重启后需要先用通行密钥登录一次（或在“设置 → 通行密钥”里解锁），助手才能使用它")

// Keeper 持有当前的主密钥。env、file 模式下主密钥固定；passkey 模式下启动时是锁定的，
// 用通行密钥解开后才保存在内存里，锁定或重启后清除。实现 Cipher，锁定时 Seal/Open 返回 ErrLocked。
type Keeper struct {
	dataDir string

	mu     sync.RWMutex
	mode   Mode
	master string // 锁定时为空
	box    *Box
}

// OpenKeeper 按启动配置创建 Keeper：envKey 非空时优先使用，不碰文件（protected 被忽略，由调用方提示）；
// 否则 protected 为真时进入锁定的 passkey 模式，数据目录里残留的 secret.key 会被删除
// （它只可能是开启保护前的旧主密钥，或关闭保护中途失败时写下的副本，两种情况下包裹的主密钥都还在）；
// 都不是时读取或生成 secret.key（见 Load）。
func OpenKeeper(envKey, dataDir string, protected bool) (*Keeper, Source, error) {
	k := &Keeper{dataDir: dataDir}
	if strings.TrimSpace(envKey) == "" && protected {
		k.mode = ModePasskey
		k.box = &Box{}
		err := os.Remove(k.Path())
		switch {
		case err == nil:
			return k, SourcePasskeyStale, nil
		case errors.Is(err, os.ErrNotExist):
			return k, SourcePasskey, nil
		default:
			return nil, "", fmt.Errorf("API key 已由通行密钥保护，但无法删除残留的 %s：%w", k.Path(), err)
		}
	}
	master, src, err := loadMaster(envKey, dataDir)
	if err != nil {
		return nil, "", err
	}
	k.master, k.box, k.mode = master, New(master), ModeFile
	if src == SourceEnv {
		k.mode = ModeEnv
	}
	return k, src, nil
}

// Path 是 secret.key 的完整路径。
func (k *Keeper) Path() string { return filepath.Join(k.dataDir, FileName) }

// Mode 返回当前的保管方式。
func (k *Keeper) Mode() Mode {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.mode
}

// Locked 报告主密钥是否由通行密钥保护且尚未解锁。
func (k *Keeper) Locked() bool {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.mode == ModePasskey && k.master == ""
}

// Enabled 报告能否保存 API key：passkey 模式下即使锁定也算（解锁后即可保存），Seal 会返回 ErrLocked。
func (k *Keeper) Enabled() bool {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.mode == ModePasskey || k.box.Enabled()
}

// Seal 用当前主密钥加密；锁定时返回 ErrLocked。
func (k *Keeper) Seal(plain, aad string) (string, error) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	if k.mode == ModePasskey && k.master == "" {
		return "", ErrLocked
	}
	return k.box.Seal(plain, aad)
}

// Open 用当前主密钥解密；锁定时返回 ErrLocked。
func (k *Keeper) Open(sealed, aad string) (string, error) {
	k.mu.RLock()
	defer k.mu.RUnlock()
	if k.mode == ModePasskey && k.master == "" {
		return "", ErrLocked
	}
	return k.box.Open(sealed, aad)
}

// Update 在写锁内运行 fn：fn 拿到当前的模式和主密钥（锁定时为空），返回新的模式和主密钥；
// fn 出错时状态不变。切换模式涉及的数据库事务和 secret.key 读写都在 fn 里完成，
// 期间所有加解密请求都会等待，避免有 key 用切换前后不一致的主密钥加密。fn 里不能再调用 Keeper 的加锁方法。
func (k *Keeper) Update(fn func(mode Mode, master string) (Mode, string, error)) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	mode, master, err := fn(k.mode, k.master)
	if err != nil {
		return err
	}
	k.mode, k.master, k.box = mode, master, New(master)
	return nil
}

// WriteFile 把主密钥写进 secret.key（先写临时文件再改名，仅所有者可读写）。可以在 Update 的 fn 里调用。
func (k *Keeper) WriteFile(master string) error {
	if err := os.MkdirAll(k.dataDir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(k.dataDir, ".secret-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_ = f.Chmod(0o600)
	if _, err := f.WriteString(master + "\n"); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, k.Path()); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// RemoveFile 删除 secret.key，文件不存在不算错误。可以在 Update 的 fn 里调用。
func (k *Keeper) RemoveFile() error {
	if err := os.Remove(k.Path()); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// NewMaster 生成一个新的随机主密钥（32 字节的 base64，与自动生成的 secret.key 格式相同）。
func NewMaster() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return base64.StdEncoding.EncodeToString(raw)
}

// ---- 用通行密钥的 PRF 输出包裹主密钥 ----

// PRFLen 是 WebAuthn PRF 扩展输出的长度。
const PRFLen = 32

// ErrUnwrap 表示 PRF 输出解不开包裹的主密钥（换了通行密钥、PRF 输出不一致或数据被改动）。
var ErrUnwrap = errors.New("这个通行密钥解不开已保存的主密钥")

const wrapPrefix = "w1:"

// wrapAEAD 由 PRF 输出和凭据 ID 派生包裹密钥：HKDF-SHA256，info 里带上凭据 ID，
// 同一个 PRF 输出不会被挪到别的凭据上使用。
func wrapAEAD(prf []byte, credID string) (cipher.AEAD, error) {
	if len(prf) < PRFLen {
		return nil, fmt.Errorf("PRF 输出长度不对：%d", len(prf))
	}
	key, err := hkdf.Key(sha256.New, prf, nil, "lode master key wrap v1|"+credID, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Wrap 用某个通行密钥的 PRF 输出包裹主密钥（AES-256-GCM，关联数据是凭据 ID）。prf 只在内存里使用。
func Wrap(prf []byte, credID, master string) (string, error) {
	aead, err := wrapAEAD(prf, credID)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := aead.Seal(nonce, nonce, []byte(master), []byte(wrapPrefix+credID))
	return wrapPrefix + base64.RawStdEncoding.EncodeToString(out), nil
}

// Unwrap 解开 Wrap 的结果，失败时返回 ErrUnwrap。
func Unwrap(prf []byte, credID, wrapped string) (string, error) {
	aead, err := wrapAEAD(prf, credID)
	if err != nil {
		return "", ErrUnwrap
	}
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(wrapped, wrapPrefix))
	if err != nil || !strings.HasPrefix(wrapped, wrapPrefix) || len(raw) < aead.NonceSize() {
		return "", ErrUnwrap
	}
	n := aead.NonceSize()
	plain, err := aead.Open(nil, raw[:n], raw[n:], []byte(wrapPrefix+credID))
	if err != nil {
		return "", ErrUnwrap
	}
	return string(plain), nil
}
