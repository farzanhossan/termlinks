package cloud

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
	"termlinks/backend/internal/auth"
	"termlinks/backend/internal/client"
)

// The outer envelope contains only a random credential selector and ciphertext.
// The selector is authenticated by selecting a distinct key for every device.
type deviceEnvelope struct {
	Version  int    `json:"v"`
	DeviceID string `json:"deviceId"`
	Packet   string `json:"packet"`
}

func (state *connectionState) applyAuth(snapshot auth.Snapshot) {
	state.authMu.Lock()
	state.authState = snapshot
	state.authMu.Unlock()
	state.channelsMu.Lock()
	channels := make(map[string]*browserChannel, len(state.channels))
	for id, ch := range state.channels {
		channels[id] = ch
	}
	state.channelsMu.Unlock()
	for id, ch := range channels {
		ch.mu.Lock()
		selected, deviceID, key := ch.selected, ch.deviceID, ch.key
		ch.mu.Unlock()
		if !selected {
			continue
		}
		secret := snapshot.Token
		if deviceID != "" {
			secret = snapshot.Keys[deviceID]
		}
		if secret == "" || deriveKey(secret) != key {
			state.closeChannel(id, websocket.ClosePolicyViolation, "Device access revoked", true)
		}
	}
}

func (state *connectionState) selectDevice(channelID string, ch *browserChannel, packet string) (string, bool) {
	bytes, err := base64.RawURLEncoding.DecodeString(packet)
	if err != nil {
		return "", false
	}
	var envelope deviceEnvelope
	if json.Unmarshal(bytes, &envelope) != nil || envelope.Version != protocolVersion || len(envelope.DeviceID) > 64 || envelope.Packet == "" {
		return "", false
	}
	state.authMu.RLock()
	secret := state.authState.Token
	if envelope.DeviceID != "" {
		secret = state.authState.Keys[envelope.DeviceID]
	}
	state.authMu.RUnlock()
	if secret == "" {
		return "", false
	}
	key := deriveKey(secret)
	ch.mu.Lock()
	defer ch.mu.Unlock()
	if ch.closed || (ch.selected && (ch.deviceID != envelope.DeviceID || ch.key != key)) {
		return "", false
	}
	ch.selected = true
	ch.deviceID = envelope.DeviceID
	ch.key = key
	return envelope.Packet, true
}

func (state *connectionState) deviceAuthentication(channelID string, ch *browserChannel, plaintext []byte) {
	var message authenticateMessage
	if json.Unmarshal(plaintext, &message) != nil || len(message.Challenge) < 16 || len(message.Challenge) > 256 {
		state.closeChannel(channelID, 1008, "Authentication failed", true)
		return
	}
	ch.mu.Lock()
	deviceID, key := ch.deviceID, ch.key
	ch.mu.Unlock()
	input := client.DeviceLogin{DeviceID: deviceID, Label: message.Label, Remember: message.Remember}
	if deviceID == "" {
		state.authMu.RLock()
		input.Token = state.authState.Token
		state.authMu.RUnlock()
		if deriveKey(input.Token) != key {
			state.closeChannel(channelID, 1008, "Token rotated", true)
			return
		}
	}
	result, err := state.control.LoginDevice(state.channelContext(ch), input)
	if err != nil {
		state.closeChannel(channelID, 1008, "Device login failed", true)
		return
	}
	if deviceID == "" {
		// Bootstrap proves the shared token but never opens application access.
		_ = state.sendEncrypted(channelID, authenticatedMessage{Version: protocolVersion, Type: "authenticated", Challenge: message.Challenge, DeviceID: result.DeviceID, Secret: result.Secret})
		return
	}
	state.authMu.RLock()
	secret := state.authState.Keys[deviceID]
	state.authMu.RUnlock()
	if secret == "" || deriveKey(secret) != key {
		state.closeChannel(channelID, 1008, "Device access revoked", true)
		return
	}
	origin, _ := url.Parse(state.localOrigin)
	ch.httpClient.Jar.SetCookies(origin, []*http.Cookie{{Name: "termlinks_session", Value: result.Session, Path: "/"}})
	ch.mu.Lock()
	if ch.closed {
		ch.mu.Unlock()
		return
	}
	ch.authenticated = true
	ch.sessionExpiry = time.Now().Add(auth.SessionDuration)
	if ch.authTimer != nil {
		ch.authTimer.Stop()
	}
	ch.mu.Unlock()
	_ = state.sendEncrypted(channelID, authenticatedMessage{Version: protocolVersion, Type: "authenticated", Challenge: message.Challenge, DeviceID: deviceID})
}

// Long-lived remembered connections renew their HTTP session without retaining
// the shared token or asking the browser to log in again after twelve hours.
func (state *connectionState) refreshDeviceSession(ch *browserChannel) error {
	ch.mu.Lock()
	id, expiry := ch.deviceID, ch.sessionExpiry
	ch.mu.Unlock()
	if id == "" || time.Until(expiry) > time.Minute {
		return nil
	}
	result, err := state.control.LoginDevice(state.channelContext(ch), client.DeviceLogin{DeviceID: id})
	if err != nil {
		return err
	}
	origin, _ := url.Parse(state.localOrigin)
	ch.httpClient.Jar.SetCookies(origin, []*http.Cookie{{Name: "termlinks_session", Value: result.Session, Path: "/"}})
	ch.mu.Lock()
	ch.sessionExpiry = time.Now().Add(auth.SessionDuration)
	ch.mu.Unlock()
	return nil
}
