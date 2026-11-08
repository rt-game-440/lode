// Package passkeytest 提供测试用的软件 WebAuthn 认证器（ES256、无证明、带用户验证），
// 仅供测试使用：把服务端给出的创建/获取选项变成浏览器会提交的 PublicKeyCredential JSON。
//
// 支持 PRF 扩展（底层相当于 CTAP2 hmac-secret）：每个凭据有一个随机的 PRFKey，
// 输出 = HMAC-SHA256(PRFKey, SHA-256("WebAuthn PRF" || 0x00 || salt))，与浏览器对盐的处理一致。
package passkeytest

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
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

	// PRFKey 是凭据的 PRF 密钥（hmac-secret 的 CredRandom）；改掉它可以模拟“同一凭据给出不同的 PRF 输出”。
	PRFKey []byte
	// NoPRF 模拟不支持 PRF 的认证器：登记时报告 enabled: false，验证时不给结果。
	NoPRF bool
	// PRFAtCreate 为真时登记就返回 PRF 结果（Chrome 147+ 的部分平台、Chrome 的虚拟认证器）；
	// 默认只返回 enabled，要再做一次验证才能拿到输出（多数平台的行为）。
	PRFAtCreate bool
}

// New 创建认证器（凭据在 Create 时才生效）。
func New() *Authenticator {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	id := make([]byte, 32)
	_, _ = rand.Read(id)
	prf := make([]byte, 32)
	_, _ = rand.Read(prf)
	return &Authenticator{key: k, CredID: id, PRFKey: prf}
}

// ID 返回凭据 ID 的 base64url，与服务端返回的通行密钥 id 相同。
func (a *Authenticator) ID() string { return b64.EncodeToString(a.CredID) }

type prfValues struct {
	First string `json:"first"`
}

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
		AllowCredentials []struct {
			ID string `json:"id"`
		} `json:"allowCredentials"`
		Extensions struct {
			PRF *struct {
				Eval             *prfValues           `json:"eval"`
				EvalByCredential map[string]prfValues `json:"evalByCredential"`
			} `json:"prf"`
		} `json:"extensions"`
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

// PRF 计算凭据对某个盐（服务端给的原始盐）的 PRF 输出。
func (a *Authenticator) PRF(salt []byte) []byte {
	h := sha256.New()
	h.Write([]byte("WebAuthn PRF"))
	h.Write([]byte{0})
	h.Write(salt)
	m := hmac.New(sha256.New, a.PRFKey)
	m.Write(h.Sum(nil))
	return m.Sum(nil)
}

// prfResult 按选项里的 PRF 输入生成 clientExtensionResults.prf；没有请求 PRF 时返回 nil。
// create 为真时是登记：只在 PRFAtCreate 时给出结果。evalByCredential 优先于 eval（与浏览器一致）。
func (a *Authenticator) prfResult(opt options, create bool) map[string]any {
	in := opt.PublicKey.Extensions.PRF
	if in == nil {
		return nil
	}
	if a.NoPRF {
		if create {
			return map[string]any{"enabled": false}
		}
		return nil
	}
	out := map[string]any{}
	if create {
		out["enabled"] = true
	}
	salt := ""
	if e, ok := in.EvalByCredential[a.ID()]; ok {
		salt = e.First
	} else if in.Eval != nil {
		salt = in.Eval.First
	}
	if salt != "" && (!create || a.PRFAtCreate) {
		if raw, err := b64.DecodeString(salt); err == nil {
			out["results"] = map[string]any{"first": b64.EncodeToString(a.PRF(raw))}
		}
	}
	return out
}

func extResults(prf map[string]any) map[string]any {
	if prf == nil {
		return map[string]any{}
	}
	return map[string]any{"prf": prf}
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
		"clientExtensionResults": extResults(a.prfResult(opt, true)),
	})
}

// ErrNotAllowed 表示选项限定了凭据（allowCredentials），但不包含这个认证器的凭据（浏览器里相当于没有可选的通行密钥）。
var ErrNotAllowed = errors.New("这个认证器的凭据不在允许列表里")

// Get 响应 navigator.credentials.get（可发现凭据：带 userHandle），每次签名计数加一。
func (a *Authenticator) Get(optionsJSON []byte, origin string) ([]byte, error) {
	opt, challenge, rpID, err := parse(optionsJSON)
	if err != nil {
		return nil, err
	}
	if allow := opt.PublicKey.AllowCredentials; len(allow) > 0 {
		ok := false
		for _, c := range allow {
			ok = ok || c.ID == a.ID()
		}
		if !ok {
			return nil, ErrNotAllowed
		}
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
		"clientExtensionResults": extResults(a.prfResult(opt, false)),
	})
}
