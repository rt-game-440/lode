// Package secret 用 AES-256-GCM 加密保存在数据库里的 API key。
// 加密密钥由环境变量 LODE_SECRET_KEY 经 HKDF-SHA256 派生；未设置时不能加密，也就不能保存 key。
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// ErrNoKey 表示没有设置 LODE_SECRET_KEY。
var ErrNoKey = errors.New("未设置 LODE_SECRET_KEY")

// ErrDecrypt 表示密文无法解密（主密钥变了或数据被篡改）。
var ErrDecrypt = errors.New("API key 无法解密：LODE_SECRET_KEY 可能已更换，请重新填写 key")

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
