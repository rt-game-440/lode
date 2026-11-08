// Package secret 用 AES-256-GCM 加密保存在数据库里的 API key。
// 加密密钥由主密钥经 HKDF-SHA256 派生。主密钥优先取环境变量 LODE_SECRET_KEY；
// 没设置时使用数据目录里的 secret.key，文件不存在则自动生成（见 Load）。
// 也可以开启“用通行密钥保护”：主密钥由通行密钥的 PRF 输出包裹，解开后只保存在内存里（见 Keeper、Wrap）。
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
)

// FileName 是数据目录里自动生成的主密钥文件名。
const FileName = "secret.key"

// Source 说明主密钥的来源。
type Source string

const (
	SourceEnv  Source = "env"  // 环境变量 LODE_SECRET_KEY
	SourceFile Source = "file" // 数据目录里已有的 secret.key
	SourceNew  Source = "new"  // 刚刚自动生成的 secret.key
)

// Load 返回可用的 Box。envKey 非空（只含空白不算）时优先使用，不碰文件；否则读 dataDir/secret.key，
// 不存在就生成 32 字节随机值写进去（仅所有者可读写，Windows 上权限位基本无效，尽力而为）。
func Load(envKey, dataDir string) (*Box, Source, error) {
	master, src, err := loadMaster(envKey, dataDir)
	if err != nil {
		return nil, "", err
	}
	return New(master), src, nil
}

func loadMaster(envKey, dataDir string) (string, Source, error) {
	if strings.TrimSpace(envKey) != "" {
		return strings.TrimSpace(envKey), SourceEnv, nil
	}
	p := filepath.Join(dataDir, FileName)
	if b, err := os.ReadFile(p); err == nil {
		if strings.TrimSpace(string(b)) == "" {
			return "", "", fmt.Errorf("%s 是空的：请删除它让 Lode 重新生成（已保存的 API key 需要重新填写）", p)
		}
		return strings.TrimSpace(string(b)), SourceFile, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", "", err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	master := base64.StdEncoding.EncodeToString(raw)
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return "", "", err
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return "", "", err
	}
	if _, err := f.WriteString(master + "\n"); err != nil {
		f.Close()
		os.Remove(p)
		return "", "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(p)
		return "", "", err
	}
	return master, SourceNew, nil
}

// ErrNoKey 表示没有设置 LODE_SECRET_KEY。
var ErrNoKey = errors.New("没有可用的主密钥")

// ErrDecrypt 表示密文无法解密（主密钥变了或数据被篡改）。
var ErrDecrypt = errors.New("API key 无法解密：主密钥（LODE_SECRET_KEY 或 secret.key）可能已更换，请重新填写 key")

const prefix = "v1:"

// Box 负责加密和解密。零值和主密钥为空时不可用。
type Box struct{ aead cipher.AEAD }

// New 由主密钥创建 Box；主密钥为空（或只有空白）时返回不可用的 Box。
func New(master string) *Box {
	master = strings.TrimSpace(master)
	if master == "" {
		return &Box{}
	}
	key, err := hkdf.Key(sha256.New, []byte(master), nil, "lode api key encryption v1", 32)
	if err != nil {
		panic(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	return &Box{aead: aead}
}

// Enabled 报告是否设置了主密钥。
func (b *Box) Enabled() bool { return b != nil && b.aead != nil }

// Seal 加密明文。aad 是关联数据（例如供应商 id），解密时必须一致，防止密文被挪到别的记录上。
func (b *Box) Seal(plain, aad string) (string, error) {
	if !b.Enabled() {
		return "", ErrNoKey
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := b.aead.Seal(nonce, nonce, []byte(plain), []byte(aad))
	return prefix + base64.RawStdEncoding.EncodeToString(out), nil
}

// Open 解密 Seal 的结果。
func (b *Box) Open(sealed, aad string) (string, error) {
	if !b.Enabled() {
		return "", ErrNoKey
	}
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(sealed, prefix))
	if err != nil || !strings.HasPrefix(sealed, prefix) || len(raw) < b.aead.NonceSize() {
		return "", ErrDecrypt
	}
	n := b.aead.NonceSize()
	plain, err := b.aead.Open(nil, raw[:n], raw[n:], []byte(aad))
	if err != nil {
		return "", ErrDecrypt
	}
	return string(plain), nil
}

// last4MinLen 是显示末 4 位所需的最短长度：更短的 key 显示末 4 位会泄露大部分内容。
const last4MinLen = 12

// Last4 返回 key 的末 4 个字符，界面上用来辨认是哪个 key；key 短于 12 个字符时返回空串。
func Last4(key string) string {
	r := []rune(key)
	if len(r) < last4MinLen {
		return ""
	}
	return string(r[len(r)-4:])
}
