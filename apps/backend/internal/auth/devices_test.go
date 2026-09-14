package auth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRenameDevicePersistenceAndValidation(t *testing.T) {
	dir := t.TempDir()
	token := strings.Repeat("a", 43)
	path := filepath.Join(dir, "devices.db")
	m, err := Open(token, "", path)
	if err != nil {
		t.Fatal(err)
	}
	d, session, _, err := m.LoginDevice("test", token, "Android · Chrome", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, label := range []string{"", " \n\t", strings.Repeat("界", 121)} {
		if err := m.RenameDevice(d.ID, label); !errors.Is(err, ErrInvalidDeviceLabel) {
			t.Fatalf("invalid name accepted: %v", err)
		}
	}
	if err := m.RenameDevice("missing", "Phone"); !errors.Is(err, ErrDeviceNotFound) {
		t.Fatal(err)
	}
	if err := m.RenameDevice(d.ID, strings.Repeat("界", 120)); err != nil {
		t.Fatal(err)
	}
	if err := m.RenameDevice(d.ID, "  iPhone   13 Pro\n"); err != nil {
		t.Fatal(err)
	}
	if got := m.Devices(session)[0]; got.Label != "iPhone 13 Pro" || got.Secret != d.Secret || !m.Valid(session) {
		t.Fatal("rename changed device access or failed to normalize")
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	m, err = Open(token, "", path)
	if err != nil {
		t.Fatal(err)
	}
	if got := m.Devices("")[0].Label; got != "iPhone 13 Pro" {
		t.Fatalf("name not persisted: %q", got)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.RenameDevice(d.ID, "Unsaved name"); err == nil {
		t.Fatal("expected closed database error")
	}
	if got := m.Devices("")[0].Label; got != "iPhone 13 Pro" {
		t.Fatal("failed write changed in-memory name")
	}
}

func TestPersistentDeviceRevocationAndRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.token")
	db := filepath.Join(dir, "devices.db")
	token := strings.Repeat("a", 43)
	if err := AtomicToken(path, token); err != nil {
		t.Fatal(err)
	}
	m, err := Open(token, path, db)
	if err != nil {
		t.Fatal(err)
	}
	first, sessionA, _, err := m.LoginDevice("a", token, "Phone", true)
	if err != nil {
		t.Fatal(err)
	}
	second, sessionB, _, err := m.LoginDevice("b", token, "Tablet", true)
	if err != nil {
		t.Fatal(err)
	}
	aClosed, bClosed := false, false
	cancelA := m.Track(sessionA, func() { aClosed = true })
	defer cancelA()
	cancelB := m.Track(sessionB, func() { bClosed = true })
	defer cancelB()
	payload, _ := json.Marshal(m.Devices(sessionA))
	if strings.Contains(string(payload), first.Secret) || strings.Contains(string(payload), token) {
		t.Fatal("device list exposed credential")
	}
	if err = m.Revoke(first.ID); err != nil {
		t.Fatal(err)
	}
	if !aClosed || bClosed || m.Valid(sessionA) || !m.Valid(sessionB) {
		t.Fatal("device revocation was not isolated")
	}
	if _, _, err = m.ResumeSecret(first.Secret); err == nil {
		t.Fatal("revoked secret accepted")
	}
	if err = m.Close(); err != nil {
		t.Fatal(err)
	}
	m, err = Open(token, path, db)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.ResumeSecret(first.Secret); err == nil {
		t.Fatal("revoked secret revived after restart")
	}
	if _, _, err = m.ResumeSecret(second.Secret); err != nil {
		t.Fatal("remembered device did not survive restart", err)
	}
	newToken, err := m.Rotate()
	if err != nil {
		t.Fatal(err)
	}
	if newToken == token {
		t.Fatal("rotation reused old token")
	}
	if _, _, err = m.ResumeSecret(second.Secret); err == nil {
		t.Fatal("old device survived rotation")
	}
	if _, _, _, err = m.LoginDevice("old", token, "Old", true); err == nil {
		t.Fatal("old token accepted")
	}
	if _, _, _, err = m.LoginDevice("new", newToken, "New", true); err != nil {
		t.Fatal(err)
	}
	m.Close()
	m, err = Open(newToken, path, db)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, _, err = m.Resume(second.ID); err == nil {
		t.Fatal("old device generation revived")
	}
	if len(m.Devices("")) != 1 {
		t.Fatal("new generation not persisted")
	}
	info, err := os.Stat(db)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("registry permissions are not private")
	}
}

func TestFailedRotationKeepsAccessAndTemporaryDevicesExpireOnRestart(t *testing.T) {
	dir := t.TempDir()
	token := strings.Repeat("b", 43)
	db := filepath.Join(dir, "devices.db")
	m, err := Open(token, filepath.Join(dir, "missing", "token"), db)
	if err != nil {
		t.Fatal(err)
	}
	d, session, _, err := m.LoginDevice("client", token, "Temporary", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Rotate(); err == nil {
		t.Fatal("expected persistence failure")
	}
	if !m.Valid(session) {
		t.Fatal("failed rotation revoked valid login")
	}
	m.Close()
	m, err = Open(token, "", db)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, _, err = m.Resume(d.ID); err == nil {
		t.Fatal("temporary device survived process restart")
	}
}

func TestRotationWaitsForConnectorAndSerializesLogin(t *testing.T) {
	m := New(strings.Repeat("c", 43))
	_, events, cancel := m.Subscribe()
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := m.Rotate(); done <- err }()
	event := <-events
	select {
	case <-done:
		t.Fatal("rotation reported success before connector acknowledgement")
	default:
	}
	event.Ack <- nil
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	cancel()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = m.Rotate() }()
	}
	wg.Wait()
	if len(m.Devices("")) != 0 {
		t.Fatal("unexpected devices")
	}
}

func TestPresenceAndMultipleSessionsPerDevice(t *testing.T) {
	m := New("token")
	clock := time.Now()
	m.now = func() time.Time { return clock }
	d, first, _, err := m.LoginDevice("a", "token", "Phone", true)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := m.Resume(d.ID)
	if err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Minute)
	if m.Devices(first)[0].Online {
		t.Fatal("stale device marked online")
	}
	if err = m.Touch(second); err != nil {
		t.Fatal(err)
	}
	if !m.Devices(first)[0].Online || !m.Devices(first)[0].Current {
		t.Fatal("presence/current device missing")
	}
	if err = m.Revoke(d.ID); err != nil {
		t.Fatal(err)
	}
	if m.Valid(first) || m.Valid(second) {
		t.Fatal("revocation left a session active")
	}
	// A current shared token can register again, as agreed in the product behavior.
	if _, _, _, err = m.LoginDevice("a", "token", "Phone", true); err != nil {
		t.Fatal(err)
	}
}

func TestExpiredSessionRetainsOnlyDeviceLogoutOwnership(t *testing.T) {
	for _, cleanup := range []string{"validation", "login", "renewal"} {
		t.Run(cleanup, func(t *testing.T) {
			m := New("token")
			clock := time.Now()
			m.now = func() time.Time { return clock }
			device, original, _, err := m.LoginDevice("phone", "token", "Temporary phone", false)
			if err != nil {
				t.Fatal(err)
			}
			closed := false
			defer m.Track(original, func() { closed = true })()
			clock = clock.Add(SessionDuration + time.Second)
			switch cleanup {
			case "validation":
				m.Valid(original)
			case "login":
				if _, _, err := m.Login("other", "token"); err != nil {
					t.Fatal(err)
				}
			case "renewal":
				if _, _, err := m.Resume(device.ID); err != nil {
					t.Fatal(err)
				}
			}
			if m.Valid(original) {
				t.Fatal("expired session still grants access")
			}
			if id := m.DeviceID(original); id != device.ID {
				t.Fatal("expiry cleanup discarded device logout ownership")
			}
			if closed {
				t.Fatal("session cleanup unexpectedly closed an existing device stream")
			}
			if _, _, err := m.ResumeSecret(device.Secret); err == nil {
				t.Fatal("temporary secret restored a direct login")
			}
			newStreamClosed := false
			m.Track(original, func() { newStreamClosed = true })()
			if !newStreamClosed {
				t.Fatal("expired session opened a new stream")
			}
			if err := m.Revoke(m.DeviceID(original)); err != nil {
				t.Fatal(err)
			}
			if !closed || len(m.Devices("")) != 0 {
				t.Fatal("expired-session logout left device access or streams active")
			}
			if m.DeviceID(original) != "" {
				t.Fatal("revocation retained logout ownership")
			}
		})
	}
}

func TestRevocationIsolatesDevicesAfterSessionRenewal(t *testing.T) {
	m := New("token")
	clock := time.Now()
	m.now = func() time.Time { return clock }
	a, originalA, _, err := m.LoginDevice("a", "token", "Phone A", true)
	if err != nil {
		t.Fatal(err)
	}
	b, originalB, _, err := m.LoginDevice("b", "token", "Phone B", true)
	if err != nil {
		t.Fatal(err)
	}
	closedA, closedB, closedRenewedA := false, false, false
	defer m.Track(originalA, func() { closedA = true })()
	defer m.Track(originalB, func() { closedB = true })()
	clock = clock.Add(SessionDuration + time.Second)
	renewedA, _, err := m.Resume(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Track(renewedA, func() { closedRenewedA = true })()
	if m.Valid(originalA) || !m.Valid(renewedA) {
		t.Fatal("session renewal did not advance authentication")
	}
	if err := m.Revoke(b.ID); err != nil {
		t.Fatal(err)
	}
	if closedA || closedRenewedA || !m.Valid(renewedA) {
		t.Fatal("removing B interrupted A's authorized device streams")
	}
	if !closedB {
		t.Fatal("removing B left its expired-session stream active")
	}
	if err := m.Revoke(a.ID); err != nil {
		t.Fatal(err)
	}
	if !closedA || !closedRenewedA {
		t.Fatal("removing A did not close both original and renewed-session streams")
	}
}
