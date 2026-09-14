package cloud

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"termlinks/backend/internal/auth"
	"termlinks/backend/internal/config"
	"termlinks/backend/internal/server"
	"termlinks/backend/internal/session"
)

type testBrowser struct {
	channel, id   string
	key           [32]byte
	send, receive uint32
}

func TestDeviceBridgeRevocationRotationAndSubscriptionLoss(t *testing.T) {
	token := strings.Repeat("a", 43)
	authentication := auth.New(token)
	sessions := session.NewManager()
	process, err := sessions.Start(session.StartOptions{Name: "survives rotation", Command: []string{"/bin/cat"}, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer process.Stop()
	handlers, err := server.New(sessions, authentication, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(handlers.WebHandler())
	defer web.Close()
	dir, err := os.MkdirTemp("/tmp", "tl-auth-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "control.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	authSockets := make(chan net.Conn, 1)
	controlHandler := handlers.ControlHandler()
	control := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/auth/events" {
			w = &captureAuthSocket{ResponseWriter: w, sockets: authSockets}
		}
		controlHandler.ServeHTTP(w, r)
	})}
	go control.Serve(listener)
	defer control.Close()
	connected := make(chan *websocket.Conn, 1)
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		connected <- connection
	}))
	defer relay.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() {
		finished <- runOnce(ctx, "ws"+strings.TrimPrefix(relay.URL, "http"), config.CloudSettings{}, web.URL, socket)
	}()
	var relayConnection *websocket.Conn
	select {
	case relayConnection = <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("connector did not connect")
	}
	defer relayConnection.Close()
	sendOuter := func(value any) {
		t.Helper()
		if err := relayConnection.WriteJSON(value); err != nil {
			t.Fatal(err)
		}
	}
	closed := make(map[string]bool)
	pending := make(map[string][]encryptedOuterMessage)
	readPacket := func(browser *testBrowser) []byte {
		t.Helper()
		for {
			var packet encryptedOuterMessage
			if len(pending[browser.channel]) > 0 {
				packet = pending[browser.channel][0]
				pending[browser.channel] = pending[browser.channel][1:]
			} else {
				_ = relayConnection.SetReadDeadline(time.Now().Add(6 * time.Second))
				_, data, err := relayConnection.ReadMessage()
				if err != nil {
					t.Fatal(err)
				}
				var outer struct{ Type, ID, Data string }
				if err = json.Unmarshal(data, &outer); err != nil {
					t.Fatal(err)
				}
				if outer.Type == "channel_close" {
					closed[outer.ID] = true
					continue
				}
				if outer.Type != "e2e_to_browser" {
					continue
				}
				packet = encryptedOuterMessage{Type: outer.Type, ID: outer.ID, Data: outer.Data}
				if outer.ID != browser.channel {
					pending[outer.ID] = append(pending[outer.ID], packet)
					continue
				}
			}
			data, err := decryptPacket(browser.key, browser.channel, "connector", browser.receive, packet.Data)
			if err != nil {
				t.Fatal(err)
			}
			browser.receive++
			return data
		}
	}
	send := func(browser *testBrowser, value any) {
		t.Helper()
		packet, err := encryptPacket(browser.key, browser.channel, "browser", browser.send, value)
		if err != nil {
			t.Fatal(err)
		}
		browser.send++
		envelope, _ := json.Marshal(deviceEnvelope{Version: protocolVersion, DeviceID: browser.id, Packet: packet})
		sendOuter(encryptedOuterMessage{Type: "e2e_from_browser", ID: browser.channel, Data: base64.RawURLEncoding.EncodeToString(envelope)})
	}
	open := func(channel, id, secret string) *testBrowser {
		t.Helper()
		b := &testBrowser{channel: channel, id: id, key: deriveKey(secret)}
		sendOuter(channelOpenMessage{Type: "channel_open", ID: channel})
		send(b, authenticateMessage{Version: protocolVersion, Type: "authenticate", Challenge: "challenge-for-device-test", Remember: true, Label: "Test phone"})
		return b
	}
	register := func(prefix string) *testBrowser {
		t.Helper()
		bootstrap := open(prefix+"0000000-0000-0000-0000-000000000001", "", token)
		var issued authenticatedMessage
		if err := json.Unmarshal(readPacket(bootstrap), &issued); err != nil {
			t.Fatal(err)
		}
		if issued.DeviceID == "" || issued.Secret == "" {
			t.Fatal("bootstrap did not issue device credential")
		}
		sendOuter(channelCloseMessage{Type: "channel_close", ID: bootstrap.channel})
		b := open(prefix+"0000000-0000-0000-0000-000000000002", issued.DeviceID, issued.Secret)
		var reply authenticatedMessage
		if err := json.Unmarshal(readPacket(b), &reply); err != nil || reply.DeviceID != b.id {
			t.Fatal("device resume failed")
		}
		return b
	}
	legacyID := "90000000-0000-4000-8000-000000000009"
	sendOuter(channelOpenMessage{Type: "channel_open", ID: legacyID})
	legacyPacket, err := encryptPacket(deriveKey(token), legacyID, "browser", 0, authenticateMessage{Version: protocolVersion, Type: "authenticate", Challenge: "legacy-test-challenge"})
	if err != nil {
		t.Fatal(err)
	}
	sendOuter(encryptedOuterMessage{Type: "e2e_from_browser", ID: legacyID, Data: legacyPacket})
	a, b := register("a"), register("b")
	if !closed[legacyID] {
		t.Fatal("legacy unscoped authentication was accepted")
	}
	// Device B opens a real terminal stream before device A revokes it.
	send(b, terminalOpenMessage{Version: protocolVersion, Type: "terminal_open", ID: "11111111-1111-4111-8111-111111111111", SessionID: process.Info().ID})
	_ = readPacket(b)
	send(a, httpRequestMessage{Version: protocolVersion, Type: "http_request", ID: "22222222-2222-4222-8222-222222222222", Method: "DELETE", Path: "/api/devices/" + b.id})
	var response httpResponseMessage
	if err = json.Unmarshal(readPacket(a), &response); err != nil || response.Status != 204 {
		t.Fatalf("remove failed: %d %v", response.Status, err)
	}
	if !closed[b.channel] {
		t.Fatal("removed device channel was not closed before completion")
	}
	if _, _, err = authentication.Resume(b.id); err == nil {
		t.Fatal("revoked credential accepted")
	}
	revoked := &testBrowser{channel: "80000000-0000-4000-8000-000000000008", id: b.id, key: b.key}
	sendOuter(channelOpenMessage{Type: "channel_open", ID: revoked.channel})
	send(revoked, authenticateMessage{Version: protocolVersion, Type: "authenticate", Challenge: "revoked-test-challenge"})
	send(a, httpRequestMessage{Version: protocolVersion, Type: "http_request", ID: "33333333-3333-4333-8333-333333333333", Method: "GET", Path: "/api/sessions"})
	if err = json.Unmarshal(readPacket(a), &response); err != nil || response.Status != 200 {
		t.Fatal("other device lost access")
	}
	if !closed[revoked.channel] {
		t.Fatal("revoked key could reconnect")
	}
	token, err = authentication.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	if !process.Info().Running {
		t.Fatal("rotation killed a managed terminal")
	}
	c := register("c")
	_ = c
	authSocket := <-authSockets
	_ = authSocket.Close()
	select {
	case err := <-finished:
		if err == nil || !strings.Contains(err.Error(), "subscription lost") {
			t.Fatal("subscription loss did not fail closed", err)
		}
	case <-time.After(6 * time.Second):
		t.Fatal("connector did not close after subscription loss")
	}
	if !process.Info().Running {
		t.Fatal("subscription loss stopped managed process")
	}
}

type captureAuthSocket struct {
	http.ResponseWriter
	sockets chan net.Conn
}

func (w *captureAuthSocket) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	connection, rw, err := w.ResponseWriter.(http.Hijacker).Hijack()
	if err == nil {
		w.sockets <- connection
	}
	return connection, rw, err
}
