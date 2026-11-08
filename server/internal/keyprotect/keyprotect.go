// Package keyprotect 实现“用通行密钥保护 API key”（#29，验收问题第 11 条方案 D）。
//
// 开启后主密钥不再以明文 secret.key 存在数据目录里：每个加入保护的通行密钥用自己的 WebAuthn PRF 输出
// （经 HKDF 派生包裹密钥）包一份主密钥，存在 passkeys.extra；secret.key 被删除。服务启动时处于锁定状态，
// 有人用加入保护的通行密钥登录（或在设置里单独验证）时，浏览器把 PRF 输出交给服务端，解开主密钥并只保存在内存里。
//
// 要点：
//   - 开启时生成新的主密钥并把已保存的 API key 重新加密，旧的 secret.key（包括以前备份里的副本）解不开开启后的 key；
//   - PRF 盐每个实例一个（settings.key_protection_salt），不保密，也不随开关变化；PRF 输出绝不写日志、不持久化；
//   - 关闭时把内存里的主密钥写回 secret.key（需要已解锁）；锁定状态下只能放弃已保存的 key 并关闭（通行密钥都丢了时用）；
//   - 设置了 LODE_SECRET_KEY 时不可用；
//   - 切换顺序保证中途崩溃不丢 key：开启先提交数据库再删 secret.key，关闭先写 secret.key 再提交数据库，
//     启动时若数据库标记已保护，残留的 secret.key 直接删除（见 secret.OpenKeeper）。
package keyprotect

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"slices"

	"github.com/rt-game-440/lode/server/internal/passkey"
	"github.com/rt-game-440/lode/server/internal/secret"
)

const (
	settingMode = "key_protection"      // 值为 "passkey" 表示已开启
	settingSalt = "key_protection_salt" // PRF 盐（base64url），首次需要时生成，之后不变
	modePasskey = "passkey"
)

var (
	// ErrUnavailable 表示设置了 LODE_SECRET_KEY，主密钥由环境变量提供，不能用通行密钥保护。
	ErrUnavailable = errors.New("设置了 LODE_SECRET_KEY 时主密钥由环境变量提供，不能用通行密钥保护")
	// ErrEnabled 表示已经开启。
	ErrEnabled = errors.New("已经开启了通行密钥保护")
	// ErrDisabled 表示没有开启。
	ErrDisabled = errors.New("没有开启通行密钥保护")
	// ErrNoPRF 表示认证器没有给出 PRF 输出（不支持 PRF 扩展）。
	ErrNoPRF = errors.New("这个通行密钥不支持 PRF 扩展，不能用来保护 API key")
	// ErrNotEnrolled 表示这个通行密钥没有加入保护（没有包裹的主密钥）。
	ErrNotEnrolled = errors.New("这个通行密钥没有加入 API key 保护")
	// ErrUnwrap 表示 PRF 输出解不开包裹的主密钥。
	ErrUnwrap = secret.ErrUnwrap
	// ErrLocked 表示还没有解锁。
	ErrLocked = secret.ErrLocked
)

// KeyRows 读写已保存的 API key（由 agent.Store 实现），开启时重新加密、找不回主密钥时清除。
type KeyRows interface {
	ResealKeys(ctx context.Context, tx *sql.Tx, from, to secret.Cipher) error
	ClearKeys(ctx context.Context, tx *sql.Tx) (int, error)
}

// Service 管理 API key 的通行密钥保护。
type Service struct {
	db       *sql.DB
	keys     *secret.Keeper
	passkeys *passkey.Service
	rows     KeyRows
	log      *slog.Logger
	salt     []byte
}

// Enabled 读取数据库里的开关（启动时决定 Keeper 的模式）。
func Enabled(ctx context.Context, db *sql.DB) (bool, error) {
	v, err := setting(ctx, db, settingMode)
	return v == modePasskey, err
}

// New 创建服务；PRF 盐不存在时生成并保存。
func New(ctx context.Context, db *sql.DB, keys *secret.Keeper, passkeys *passkey.Service, rows KeyRows, log *slog.Logger) (*Service, error) {
	if log == nil {
		log = slog.Default()
	}
	salt, err := loadSalt(ctx, db)
	if err != nil {
		return nil, err
	}
	return &Service{db: db, keys: keys, passkeys: passkeys, rows: rows, log: log, salt: salt}, nil
}

func setting(ctx context.Context, q passkey.DBTX, key string) (string, error) {
	var v string
	err := q.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

func loadSalt(ctx context.Context, db *sql.DB) ([]byte, error) {
	v, err := setting(ctx, db, settingSalt)
	if err != nil {
		return nil, err
	}
	if v == "" {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return nil, err
		}
		// 并发时以先写入的为准
		if _, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)`, settingSalt,
			base64.RawURLEncoding.EncodeToString(b)); err != nil {
			return nil, err
		}
		if v, err = setting(ctx, db, settingSalt); err != nil {
			return nil, err
		}
	}
	return base64.RawURLEncoding.DecodeString(v)
}

// Salt 返回 PRF 盐（开启、解锁和加入保护的验证都用它）。
func (s *Service) Salt() []byte { return slices.Clone(s.salt) }

// LoginSalt 供 passkey.Service.PRFSalt 使用：开启保护时返回 PRF 盐，让登录和登记顺便拿到 PRF 输出；否则返回 nil。
func (s *Service) LoginSalt() []byte {
	if s.keys.Mode() != secret.ModePasskey {
		return nil
	}
	return s.Salt()
}

// Status 是保护的当前状态，设置页据此显示开关和操作。
type Status struct {
	Available bool   `json:"available"`        // false：设置了 LODE_SECRET_KEY
	Reason    string `json:"reason,omitempty"` // 不可用的原因：env
	Enabled   bool   `json:"enabled"`
	Unlocked  bool   `json:"unlocked"`
	Wrapped   int    `json:"wrapped"` // 加入保护的通行密钥个数
}

// Status 返回当前状态。
func (s *Service) Status(ctx context.Context) (Status, error) {
	mode := s.keys.Mode()
	st := Status{Available: mode != secret.ModeEnv, Enabled: mode == secret.ModePasskey}
	if !st.Available {
		st.Reason = "env"
	}
	st.Unlocked = st.Enabled && !s.keys.Locked()
	ids, err := s.passkeys.Wrapped(ctx, "")
	st.Wrapped = len(ids)
	return st, err
}

// Enable 开启保护：用 credID 这个通行密钥的 PRF 输出包裹一个新生成的主密钥，已保存的 API key 改用新主密钥加密，
// 然后删除 secret.key。开启后处于已解锁状态。
func (s *Service) Enable(ctx context.Context, credID string, prf []byte) error {
	if len(prf) < secret.PRFLen {
		return ErrNoPRF
	}
	err := s.keys.Update(func(mode secret.Mode, master string) (secret.Mode, string, error) {
		switch {
		case mode == secret.ModeEnv:
			return "", "", ErrUnavailable
		case mode == secret.ModePasskey:
			return "", "", ErrEnabled
		case master == "":
			return "", "", secret.ErrNoKey
		}
		next := secret.NewMaster()
		wrap, err := secret.Wrap(prf, credID, next)
		if err != nil {
			return "", "", err
		}
		err = s.tx(ctx, func(tx *sql.Tx) error {
			if err := s.rows.ResealKeys(ctx, tx, secret.New(master), secret.New(next)); err != nil {
				return err
			}
			if err := s.passkeys.ClearWraps(ctx, tx); err != nil {
				return err
			}
			if err := s.passkeys.SetWrap(ctx, tx, credID, wrap); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
				settingMode, modePasskey)
			return err
		})
		if err != nil {
			return "", "", err
		}
		return secret.ModePasskey, next, nil
	})
	if err != nil {
		return err
	}
	// 数据库已提交：旧 secret.key 里的主密钥已经解不开现在的 key，删除失败也只是残留，下次启动会再删
	if err := s.keys.RemoveFile(); err != nil {
		s.log.Warn("开启了通行密钥保护，但删除 secret.key 失败，下次启动时会再尝试", "err", err)
	}
	s.log.Info("已开启通行密钥保护 API key", "passkey", credID)
	return nil
}

// Unlock 用 credID 的 PRF 输出解开主密钥，保存在内存里。
func (s *Service) Unlock(ctx context.Context, credID string, prf []byte) error {
	if s.keys.Mode() != secret.ModePasskey {
		return ErrDisabled
	}
	if len(prf) < secret.PRFLen {
		return ErrNoPRF
	}
	wrap, err := s.passkeys.Wrap(ctx, s.db, credID)
	if err != nil {
		return err
	}
	if wrap == "" {
		return ErrNotEnrolled
	}
	master, err := secret.Unwrap(prf, credID, wrap)
	if err != nil {
		return ErrUnwrap
	}
	return s.keys.Update(func(mode secret.Mode, _ string) (secret.Mode, string, error) {
		if mode != secret.ModePasskey {
			return "", "", ErrDisabled
		}
		return mode, master, nil
	})
}

// Enroll 让 credID 这个通行密钥也能解锁：用它的 PRF 输出包裹内存里的主密钥。需要已解锁。
func (s *Service) Enroll(ctx context.Context, credID string, prf []byte) error {
	if len(prf) < secret.PRFLen {
		return ErrNoPRF
	}
	return s.keys.Update(func(mode secret.Mode, master string) (secret.Mode, string, error) {
		if mode != secret.ModePasskey {
			return "", "", ErrDisabled
		}
		if master == "" {
			return "", "", ErrLocked
		}
		wrap, err := secret.Wrap(prf, credID, master)
		if err != nil {
			return "", "", err
		}
		if err := s.passkeys.SetWrap(ctx, s.db, credID, wrap); err != nil {
			return "", "", err
		}
		return mode, master, nil
	})
}

// AfterLogin 在通行密钥登录成功后调用：这个通行密钥加入了保护就解锁；没加入且当前已解锁就顺便加入。
// 失败只记日志（登录本身已经成功），返回是否处于已解锁状态。
func (s *Service) AfterLogin(ctx context.Context, credID string, prf []byte) bool {
	if s.keys.Mode() != secret.ModePasskey {
		return false
	}
	if prf == nil {
		s.log.Info("通行密钥登录没有带回 PRF 输出，API key 保持锁定", "passkey", credID, "locked", s.keys.Locked())
		return !s.keys.Locked()
	}
	err := s.Unlock(ctx, credID, prf)
	switch {
	case err == nil:
		s.log.Info("已用通行密钥解锁 API key", "passkey", credID)
	case errors.Is(err, ErrNotEnrolled) && !s.keys.Locked():
		if err := s.Enroll(ctx, credID, prf); err != nil {
			s.log.Warn("把通行密钥加入 API key 保护失败", "passkey", credID, "err", err)
		} else {
			s.log.Info("通行密钥已加入 API key 保护", "passkey", credID)
		}
	default:
		s.log.Warn("通行密钥没能解锁 API key", "passkey", credID, "err", err)
	}
	return !s.keys.Locked()
}

// Lock 立即锁定：清除内存里的主密钥。之后要用通行密钥再解锁。
func (s *Service) Lock() error {
	return s.keys.Update(func(mode secret.Mode, _ string) (secret.Mode, string, error) {
		if mode != secret.ModePasskey {
			return "", "", ErrDisabled
		}
		return mode, "", nil
	})
}

// Disable 关闭保护，回到 secret.key：已解锁时把主密钥写回 secret.key，已保存的 key 不受影响；
// 锁定时主密钥拿不回来，只有 discard 为真才继续——生成新的 secret.key 并清除已保存的 API key（需要重新填写）。
// 返回清除的 key 数量。
func (s *Service) Disable(ctx context.Context, discard bool) (int, error) {
	cleared := 0
	err := s.keys.Update(func(mode secret.Mode, master string) (secret.Mode, string, error) {
		if mode != secret.ModePasskey {
			return "", "", ErrDisabled
		}
		next := master
		if next == "" {
			if !discard {
				return "", "", ErrLocked
			}
			next = secret.NewMaster()
		}
		// 先写 secret.key 再提交：中途失败时数据库仍是“已保护”，启动时删掉这个文件即可，不会丢 key
		if err := s.keys.WriteFile(next); err != nil {
			return "", "", fmt.Errorf("写入 secret.key: %w", err)
		}
		err := s.tx(ctx, func(tx *sql.Tx) error {
			if master == "" {
				n, err := s.rows.ClearKeys(ctx, tx)
				if err != nil {
					return err
				}
				cleared = n
			}
			if err := s.passkeys.ClearWraps(ctx, tx); err != nil {
				return err
			}
			_, err := tx.ExecContext(ctx, `DELETE FROM settings WHERE key = ?`, settingMode)
			return err
		})
		if err != nil {
			if rmErr := s.keys.RemoveFile(); rmErr != nil {
				s.log.Error("关闭通行密钥保护失败，且无法删除刚写入的 secret.key", "err", rmErr)
			}
			cleared = 0
			return "", "", err
		}
		return secret.ModeFile, next, nil
	})
	if err != nil {
		return 0, err
	}
	s.log.Info("已关闭通行密钥保护，主密钥回到 secret.key", "cleared_keys", cleared)
	return cleared, nil
}

// LastWrapped 判断删除 credID 后是否就没有能解锁 API key 的通行密钥了（只在开启保护时可能为真）。
func (s *Service) LastWrapped(ctx context.Context, credID string) (bool, error) {
	if s.keys.Mode() != secret.ModePasskey {
		return false, nil
	}
	ids, err := s.passkeys.Wrapped(ctx, "")
	if err != nil {
		return false, err
	}
	return len(ids) == 1 && ids[0] == credID, nil
}

// AfterDelete 在删除通行密钥后调用：已经没有能解锁的通行密钥时自动关闭保护——已解锁则主密钥写回 secret.key，
// 锁定则已保存的 key 找不回来，清除后关闭。返回是否关闭了保护和清除的 key 数量。
func (s *Service) AfterDelete(ctx context.Context) (bool, int, error) {
	if s.keys.Mode() != secret.ModePasskey {
		return false, 0, nil
	}
	ids, err := s.passkeys.Wrapped(ctx, "")
	if err != nil || len(ids) > 0 {
		return false, 0, err
	}
	n, err := s.Disable(ctx, true)
	return err == nil, n, err
}

func (s *Service) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// ResetOffline 在服务停止时（lode reset-password --clear-passkeys 删除了全部通行密钥之后）关闭保护：
// 主密钥已经无法解开，清除已保存的 API key 并去掉开关，下次启动时自动生成新的 secret.key。返回是否原本开启了保护。
func ResetOffline(ctx context.Context, db *sql.DB, rows KeyRows) (bool, int, error) {
	on, err := Enabled(ctx, db)
	if err != nil || !on {
		return false, 0, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return true, 0, err
	}
	defer tx.Rollback()
	n, err := rows.ClearKeys(ctx, tx)
	if err != nil {
		return true, 0, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE passkeys SET extra = '{}'`); err != nil {
		return true, 0, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM settings WHERE key = ?`, settingMode); err != nil {
		return true, 0, err
	}
	return true, n, tx.Commit()
}
