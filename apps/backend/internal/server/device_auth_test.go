package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"termlinks/backend/internal/auth"
	"termlinks/backend/internal/session"
)

func TestDeviceRenameHTTP(t *testing.T) {
	token := strings.Repeat("d", 43)
	manager := auth.New(token)
	d, sessionCookie, _, err := manager.LoginDevice("test", token, "Phone", true)
	if err != nil {
		t.Fatal(err)
	}
	handlers, err := New(session.NewManager(), manager, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, id, body, origin string
		authenticated          bool
		status                 int
	}{
		{"rename", d.ID, `{"label":"  OnePlus  12 "}`, "http://localhost", true, 204},
		{"empty", d.ID, `{"label":" "}`, "http://localhost", true, 400},
		{"long", d.ID, `{"label":"` + strings.Repeat("a", 121) + `"}`, "http://localhost", true, 400},
		{"invalid JSON", d.ID, `{`, "http://localhost", true, 400},
		{"missing", "missing", `{"label":"Phone"}`, "http://localhost", true, 404},
		{"signed out", d.ID, `{"label":"Phone"}`, "http://localhost", false, 401},
		{"cross origin", d.ID, `{"label":"Phone"}`, "http://other.example", true, 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("PATCH", "http://localhost/api/devices/"+test.id, strings.NewReader(test.body))
			r.Header.Set("Origin", test.origin)
			r.Header.Set("Content-Type", "application/json")
			if test.authenticated {
				r.AddCookie(&http.Cookie{Name: cookieName, Value: sessionCookie})
			}
			w := httptest.NewRecorder()
			handlers.WebHandler().ServeHTTP(w, r)
			if w.Code != test.status {
				t.Fatalf("status %d, want %d: %s", w.Code, test.status, w.Body.String())
			}
		})
	}
	if manager.Devices(sessionCookie)[0].Label != "OnePlus 12" {
		t.Fatal("rename failed or rejected request changed the name")
	}
}

func TestDirectDeviceLogoutRevokesRememberedLoginAndClosesStream(t *testing.T) {
	token := strings.Repeat("d", 43)
	manager := auth.New(token)
	sessions := session.NewManager()
	process, err := sessions.Start(session.StartOptions{Name: "logout test", Command: []string{"/bin/cat"}, Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer process.Stop()
	handlers, err := New(sessions, manager, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(handlers.WebHandler())
	defer web.Close()
	request := func(method, path string, body []byte, cookies []*http.Cookie) *http.Response {
		t.Helper()
		req, err := http.NewRequest(method, web.URL+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", web.URL)
		req.Header.Set("Content-Type", "application/json")
		for _, c := range cookies {
			req.AddCookie(c)
		}
		response, err := web.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	login := func(label string) []*http.Cookie {
		t.Helper()
		body, _ := json.Marshal(deviceLogin{Token: token, Label: label, Remember: true})
		response := request("POST", "/api/login", body, nil)
		defer response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal("login failed")
		}
		cookies := response.Cookies()
		if len(cookies) != 2 {
			t.Fatal("missing session/resume cookies")
		}
		for _, cookie := range cookies {
			if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
				t.Fatal("cookie protections missing")
			}
		}
		return cookies
	}
	first, second := login("Phone"), login("Tablet")
	headers := http.Header{"Origin": {web.URL}}
	var cookieHeader []string
	for _, cookie := range first {
		cookieHeader = append(cookieHeader, cookie.Name+"="+cookie.Value)
	}
	headers.Set("Cookie", strings.Join(cookieHeader, "; "))
	socket, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(web.URL, "http")+"/ws/sessions/"+process.Info().ID, headers)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	// Wait until the upgraded connection is registered and serving output.
	_ = socket.SetReadDeadline(time.Now().Add(3 * time.Second))
	if _, _, err = socket.ReadMessage(); err != nil {
		t.Fatal(err)
	}
	response := request("POST", "/api/logout", nil, first)
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal("logout failed")
	}
	_ = socket.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err = socket.ReadMessage(); err != nil {
			break
		}
	}
	if timeout, ok := err.(interface{ Timeout() bool }); ok && timeout.Timeout() {
		t.Fatal("logout left terminal stream open")
	}
	if !process.Info().Running {
		t.Fatal("logout stopped the terminal process")
	}
	response = request("GET", "/api/me", nil, first)
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("revoked remembered cookie restored access")
	}
	response = request("GET", "/api/me", nil, second)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("logout revoked another device")
	}
	response = request("POST", "/api/logout", nil, first)
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal("logout is not idempotent")
	}
	// Even if the short-lived session is gone, logout revokes its resume cookie.
	for _, cookie := range second {
		if cookie.Name == cookieName {
			manager.Logout(cookie.Value)
		}
	}
	response = request("POST", "/api/logout", nil, second)
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal("expired-session logout failed")
	}
	response = request("GET", "/api/me", nil, second)
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("expired-session logout retained resume access")
	}
}

func TestLogoutWithInvalidTemporarySessionRevokesOtherDeviceStreams(t *testing.T) {
	manager := auth.New("token")
	device, original, _, err := manager.LoginDevice("phone", "token", "Temporary phone", false)
	if err != nil {
		t.Fatal(err)
	}
	// Invalidate the HTTP session deterministically. Auth-manager tests cover
	// the same ownership retention through clock expiry and all cleanup paths.
	manager.Logout(original)
	otherTab, _, err := manager.Resume(device.ID)
	if err != nil {
		t.Fatal(err)
	}
	closed := false
	defer manager.Track(otherTab, func() { closed = true })()
	handlers, err := New(session.NewManager(), manager, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	web := handlers.WebHandler()
	call := func(method, path, cookie string) int {
		t.Helper()
		req := httptest.NewRequest(method, "http://portal.test"+path, nil)
		req.Header.Set("Origin", "http://portal.test")
		req.AddCookie(&http.Cookie{Name: cookieName, Value: cookie})
		response := httptest.NewRecorder()
		web.ServeHTTP(response, req)
		return response.Code
	}
	if code := call("GET", "/api/me", original); code != http.StatusUnauthorized {
		t.Fatal("invalid session still authorized an API request")
	}
	if code := call("POST", "/api/logout", "unknown-session"); code != http.StatusNoContent {
		t.Fatal("unknown-session logout was not idempotent")
	}
	if closed || !manager.Valid(otherTab) {
		t.Fatal("unknown cookie revoked a device")
	}
	if code := call("POST", "/api/logout", original); code != http.StatusNoContent {
		t.Fatal("temporary-session logout failed")
	}
	if !closed || manager.Valid(otherTab) || len(manager.Devices("")) != 0 {
		t.Fatal("temporary-session logout left device access or another tab's stream active")
	}
	if _, _, err := manager.Resume(device.ID); err == nil {
		t.Fatal("logged-out temporary device could resume")
	}
	if code := call("POST", "/api/logout", original); code != http.StatusNoContent {
		t.Fatal("repeated logout failed")
	}
}
