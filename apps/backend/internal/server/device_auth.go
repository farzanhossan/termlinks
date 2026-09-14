package server

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"termlinks/backend/internal/auth"
)

const resumeCookieName = "termlinks_device"

type deviceLogin struct {
	Token    string `json:"token"`
	Label    string `json:"label"`
	Remember bool   `json:"remember"`
	DeviceID string `json:"deviceId"`
}
type deviceLoginResult struct {
	Authenticated bool   `json:"authenticated"`
	DeviceID      string `json:"deviceId"`
	Secret        string `json:"secret,omitempty"`
	Session       string `json:"session,omitempty"`
}

func (s *Server) authControlRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/auth/token", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"token": s.auth.Token()})
	})
	mux.HandleFunc("POST /v1/auth/rotate", func(w http.ResponseWriter, r *http.Request) {
		token, err := s.auth.Rotate()
		if err != nil {
			writeError(w, 503, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"token": token})
	})
	mux.HandleFunc("POST /v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var input deviceLogin
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			writeError(w, 400, "invalid device login")
			return
		}
		if input.DeviceID != "" {
			session, _, err := s.auth.Resume(input.DeviceID)
			if err != nil {
				writeError(w, 401, "device access revoked")
				return
			}
			writeJSON(w, 200, deviceLoginResult{Authenticated: true, DeviceID: input.DeviceID, Session: session})
			return
		}
		d, session, _, err := s.auth.LoginDevice("cloud", input.Token, input.Label, input.Remember)
		if err != nil {
			writeError(w, 401, "device login failed")
			return
		}
		writeJSON(w, 200, deviceLoginResult{Authenticated: true, DeviceID: d.ID, Secret: d.Secret, Session: session})
	})
	mux.HandleFunc("GET /v1/auth/events", s.authEvents)
}

func (s *Server) authEvents(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "" }}
	connection, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer connection.Close()
	connection.SetReadLimit(128)
	snapshot, events, cancel := s.auth.Subscribe()
	defer cancel()
	send := func(snapshot auth.Snapshot) error {
		_ = connection.SetWriteDeadline(time.Now().Add(3 * time.Second))
		if err := connection.WriteJSON(snapshot); err != nil {
			return err
		}
		_ = connection.SetReadDeadline(time.Now().Add(3 * time.Second))
		var ack struct {
			Ack bool `json:"ack"`
		}
		if err := connection.ReadJSON(&ack); err != nil {
			return err
		}
		if !ack.Ack {
			return auth.ErrInvalidCredentials
		}
		return nil
	}
	if send(snapshot) != nil {
		return
	}
	// Periodic snapshots detect a dead subscription even without mutations.
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event := <-events:
			err := send(event.State)
			event.Ack <- err
			if err != nil {
				return
			}
			snapshot = event.State
		case <-tick.C:
			if send(snapshot) != nil {
				return
			}
		}
	}
}

func (s *Server) deviceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/devices", s.requireWebAuth(func(w http.ResponseWriter, r *http.Request) {
		cookie, _ := r.Cookie(cookieName)
		writeJSON(w, 200, map[string]any{"devices": s.auth.Devices(cookie.Value)})
	}))
	mux.HandleFunc("POST /api/devices/heartbeat", s.requireWebAuth(func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, 403, "cross-origin request rejected")
			return
		}
		cookie, _ := r.Cookie(cookieName)
		if err := s.auth.Touch(cookie.Value); err != nil {
			writeError(w, 401, "device access unavailable")
			return
		}
		w.WriteHeader(204)
	}))
	mux.HandleFunc("DELETE /api/devices/{id}", s.requireWebAuth(func(w http.ResponseWriter, r *http.Request) {
		if !sameOrigin(r) {
			writeError(w, 403, "cross-origin request rejected")
			return
		}
		if err := s.auth.Revoke(r.PathValue("id")); err != nil {
			writeError(w, 503, err.Error())
			return
		}
		w.WriteHeader(204)
	}))
}

func setSessionCookie(w http.ResponseWriter, r *http.Request, value string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: value, Path: "/", Expires: expires, MaxAge: int(auth.SessionDuration.Seconds()), HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
}
func setResumeCookie(w http.ResponseWriter, r *http.Request, value string) {
	maxAge := -1
	var expires time.Time
	if value != "" {
		maxAge = 365 * 24 * 60 * 60
		expires = time.Now().Add(time.Duration(maxAge) * time.Second)
	}
	http.SetCookie(w, &http.Cookie{Name: resumeCookieName, Value: value, Path: "/", Expires: expires, MaxAge: maxAge, HttpOnly: true, Secure: r.TLS != nil, SameSite: http.SameSiteStrictMode})
}
