// Package passkeytest 提供测试用的软件 WebAuthn 认证器（ES256、无证明、带用户验证），
// 仅供测试使用：把服务端给出的创建/获取选项变成浏览器会提交的 PublicKeyCredential JSON。
package passkeytest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"

	"github.com/fxamacker/cbor/v2"
)

var b64 = base64.RawURLEncoding

// Authenticator 是一个持有单个凭据的软件认证器。
type Authenticator struct {
	key        *ecdsa.PrivateKey
	CredID     []byte
	UserHandle []byte
	SignCount  uint32
}

// New 创建认证器（凭据在 Create 时才生效）。
func New() *Authenticator {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	id := make([]byte, 32)
	_, _ = rand.Read(id)
	return &Authenticator{key: k, CredID: id}
}

// ID 返回凭据 ID 的 base64url，与服务端返回的通行密钥 id 相同。
func (a *Authenticator) ID() string { return b64.EncodeToString(a.CredID) }

type options struct {
	PublicKey struct {
		Challenge string `json:"challenge"`
		RP        struct {
			ID string `json:"id"`
		} `json:"rp"`
		RPID string `json:"rpId"`
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	} `json:"publicKey"`
}

func parse(optionsJSON []byte) (opt options, challenge []byte, rpID string, err error) {
	if err = json.Unmarshal(optionsJSON, &opt); err != nil {
		return
	}
	if challenge, err = b64.DecodeString(opt.PublicKey.Challenge); err != nil {
		return
	}
	rpID = opt.PublicKey.RPID
	if rpID == "" {
		rpID = opt.PublicKey.RP.ID
	}
	if rpID == "" {
		err = errors.New("选项里没有 RP ID")
	}
	return
}

func clientData(typ string, challenge []byte, origin string) []byte {
	b, _ := json.Marshal(map[string]any{"type": typ, "challenge": b64.EncodeToString(challenge), "origin": origin, "crossOrigin": false})
	return b
}

// Create 响应 navigator.credentials.create：optionsJSON 是服务端 begin 接口返回的 options。
func (a *Authenticator) Create(optionsJSON []byte, origin string) ([]byte, error) {
	opt, challenge, rpID, err := parse(optionsJSON)
	if err != nil {
		return nil, err
	}
	if a.UserHandle, err = b64.DecodeString(opt.PublicKey.User.ID); err != nil {
		return nil, err
	}
	x, y := a.key.PublicKey.X.FillBytes(make([]byte, 32)), a.key.PublicKey.Y.FillBytes(make([]byte, 32))
	cose, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: x, -3: y})
	if err != nil {
		return nil, err
	}
	rpHash := sha256.Sum256([]byte(rpID))
	authData := append([]byte{}, rpHash[:]...)
	authData = append(authData, 0x01|0x04|0x40) // UP | UV | AT
	authData = binary.BigEndian.AppendUint32(authData, a.SignCount)
	authData = append(authData, make([]byte, 16)...) // AAGUID 全零
	authData = binary.BigEndian.AppendUint16(authData, uint16(len(a.CredID)))
	authData = append(authData, a.CredID...)
	authData = append(authData, cose...)
	att, err := cbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": authData})
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{
		"id": a.ID(), "rawId": a.ID(), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(clientData("webauthn.create", challenge, origin)),
			"attestationObject": b64.EncodeToString(att),
			"transports":        []string{"internal"},
		},
		"clientExtensionResults": map[string]any{},
	})
}

// Get 响应 navigator.credentials.get（可发现凭据：带 userHandle），每次签名计数加一。
func (a *Authenticator) Get(optionsJSON []byte, origin string) ([]byte, error) {
	_, challenge, rpID, err := parse(optionsJSON)
	if err != nil {
		return nil, err
	}
	a.SignCount++
	rpHash := sha256.Sum256([]byte(rpID))
	authData := append([]byte{}, rpHash[:]...)
	authData = append(authData, 0x01|0x04) // UP | UV
	authData = binary.BigEndian.AppendUint32(authData, a.SignCount)
	cd := clientData("webauthn.get", challenge, origin)
	cdHash := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, authData...), cdHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, a.key, digest[:])
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]any{
		"id": a.ID(), "rawId": a.ID(), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(cd),
			"authenticatorData": b64.EncodeToString(authData),
			"signature":         b64.EncodeToString(sig),
			"userHandle":        b64.EncodeToString(a.UserHandle),
		},
		"clientExtensionResults": map[string]any{},
	})
}
