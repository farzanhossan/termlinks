package cloud

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestCloudPortalEndToEnd is opt-in because it targets a deployed personal portal.
// It verifies E2E authentication, encrypted session listing, and encrypted terminal
// output. It sends no terminal input unless TERMLINKS_E2E_SEND is also provided.
func TestCloudPortalEndToEnd(t *testing.T) {
	portal := strings.TrimRight(os.Getenv("TERMLINKS_E2E_PORTAL"), "/")
	token := os.Getenv("TERMLINKS_E2E_TOKEN")
	if portal == "" || token == "" {
		t.Skip("set TERMLINKS_E2E_PORTAL and TERMLINKS_E2E_TOKEN to run")
	}
	portalURL, err := url.Parse(portal)
	if err != nil || portalURL.Scheme != "https" || portalURL.Host == "" {
		t.Fatal("TERMLINKS_E2E_PORTAL must be an https URL")
	}
	websocketURL := *portalURL
	websocketURL.Scheme = "wss"
	websocketURL.Path = "/ws/bridge"
	connection, key, channelID, deviceID := connectDeviceForTest(t, websocketURL.String(), portal, token)
	defer connection.Close()
	var sendSequence, receiveSequence uint32 = 1, 1

	requestID := "11111111-1111-4111-8111-111111111111"
	writeEncryptedForTest(t, connection, key, channelID, deviceID, &sendSequence, httpRequestMessage{
		Version: protocolVersion, Type: "http_request", ID: requestID, Method: http.MethodGet, Path: "/api/sessions",
	})
	var apiResponse httpResponseMessage
	readEncryptedForTest(t, connection, key, channelID, &receiveSequence, &apiResponse)
	if apiResponse.Type != "http_response" || apiResponse.ID != requestID || apiResponse.Status != http.StatusOK {
		t.Fatalf("encrypted session listing returned status %d", apiResponse.Status)
	}
	var output struct {
		Sessions []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"sessions"`
	}
	if json.Unmarshal([]byte(apiResponse.Body), &output) != nil || len(output.Sessions) == 0 {
		t.Fatal("encrypted session listing did not contain a session")
	}
	targetSession := output.Sessions[0]
	if wanted := os.Getenv("TERMLINKS_E2E_SESSION_NAME"); wanted != "" {
		found := false
		for _, session := range output.Sessions {
			if session.Name == wanted {
				targetSession = session
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("requested smoke-test session %q was not found", wanted)
		}
	}

	terminalID := "22222222-2222-4222-8222-222222222222"
	writeEncryptedForTest(t, connection, key, channelID, deviceID, &sendSequence, terminalOpenMessage{
		Version: protocolVersion, Type: "terminal_open", ID: terminalID, SessionID: targetSession.ID,
	})
	input := os.Getenv("TERMLINKS_E2E_SEND")
	opened := false
	var terminalOutput []byte
	for !opened || len(terminalOutput) == 0 || (input != "" && !bytes.Contains(terminalOutput, []byte(input))) {
		var raw json.RawMessage
		readEncryptedForTest(t, connection, key, channelID, &receiveSequence, &raw)
		var kind innerMessageType
		if json.Unmarshal(raw, &kind) != nil {
			t.Fatal("connector returned invalid encrypted terminal JSON")
		}
		switch kind.Type {
		case "terminal_opened":
			opened = true
			if input != "" {
				writeEncryptedForTest(t, connection, key, channelID, deviceID, &sendSequence, terminalDataMessage{
					Version: protocolVersion, Type: "terminal_data", ID: terminalID, Binary: true,
					Data: base64.RawURLEncoding.EncodeToString([]byte(input + "\n")),
				})
			}
		case "terminal_data":
			var message terminalDataMessage
			if json.Unmarshal(raw, &message) != nil || message.ID != terminalID {
				t.Fatal("connector returned invalid encrypted terminal data")
			}
			if !message.Binary {
				// Snapshot framing and terminal status travel as text controls.
				continue
			}
			data, err := base64.RawURLEncoding.DecodeString(message.Data)
			if err != nil {
				t.Fatal(err)
			}
			terminalOutput = append(terminalOutput, data...)
		case "terminal_close":
			t.Fatal("terminal closed before the E2E smoke test completed")
		}
	}
	writeEncryptedForTest(t, connection, key, channelID, deviceID, &sendSequence, terminalCloseMessage{
		Version: protocolVersion, Type: "terminal_close", ID: terminalID, Code: websocket.CloseNormalClosure, Reason: "Smoke test complete",
	})
	_ = connection.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Smoke test complete"), time.Now().Add(2*time.Second))
}

func writeEncryptedForTest(t *testing.T, connection *websocket.Conn, key [32]byte, channel, deviceID string, sequence *uint32, value any) {
	t.Helper()
	packet, err := encryptPacket(key, channel, "browser", *sequence, value)
	if err != nil {
		t.Fatal(err)
	}
	envelope, _ := json.Marshal(deviceEnvelope{Version: protocolVersion, DeviceID: deviceID, Packet: packet})
	if err := connection.WriteMessage(websocket.TextMessage, []byte(base64.RawURLEncoding.EncodeToString(envelope))); err != nil {
		t.Fatal(err)
	}
	*sequence++
}

func readEncryptedForTest(t *testing.T, connection *websocket.Conn, key [32]byte, channel string, sequence *uint32, output any) {
	t.Helper()
	kind, packet, err := connection.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.TextMessage {
		t.Fatal("relay returned a non-text encrypted envelope")
	}
	plaintext, err := decryptPacket(key, channel, "connector", *sequence, string(packet))
	if err != nil {
		t.Fatalf("relay payload was not valid E2E ciphertext: %v", err)
	}
	if raw, ok := output.(*json.RawMessage); ok {
		*raw = append((*raw)[:0], plaintext...)
		*sequence++
		return
	}
	if err := json.Unmarshal(plaintext, output); err != nil {
		t.Fatal(err)
	}
	*sequence++
}

func connectDeviceForTest(t *testing.T, websocketURL, portal, token string) (*websocket.Conn, [32]byte, string, string) {
	t.Helper()
	secret, id := token, ""
	for attempt := 0; attempt < 2; attempt++ {
		connection, response, err := (&websocket.Dialer{HandshakeTimeout: 15 * time.Second}).Dial(websocketURL, http.Header{"Origin": {portal}})
		if err != nil {
			if response != nil {
				t.Fatalf("bridge returned HTTP %d", response.StatusCode)
			}
			t.Fatal(err)
		}
		_ = connection.SetReadDeadline(time.Now().Add(20 * time.Second))
		var ready struct{ Type, ID, Protocol string }
		if err = connection.ReadJSON(&ready); err != nil || ready.Type != "bridge_ready" || ready.Protocol != "e2e-v2" {
			connection.Close()
			t.Fatal("invalid bridge greeting", err)
		}
		key := deriveKey(secret)
		var send, receive uint32
		challenge := "termlinks-device-smoke-challenge"
		writeEncryptedForTest(t, connection, key, ready.ID, id, &send, authenticateMessage{Version: protocolVersion, Type: "authenticate", Challenge: challenge})
		var result authenticatedMessage
		readEncryptedForTest(t, connection, key, ready.ID, &receive, &result)
		if result.Challenge != challenge || result.Type != "authenticated" {
			connection.Close()
			t.Fatal("authentication proof failed")
		}
		if id != "" {
			if result.DeviceID != id {
				t.Fatal("device identity mismatch")
			}
			return connection, key, ready.ID, id
		}
		connection.Close()
		id, secret = result.DeviceID, result.Secret
		if id == "" || secret == "" {
			t.Fatal("missing device credential")
		}
	}
	t.Fatal("device login failed")
	return nil, [32]byte{}, "", ""
}
