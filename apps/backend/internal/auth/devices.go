package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Device struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	CreatedAt time.Time `json:"createdAt"`
	LastSeen  time.Time `json:"lastSeen"`
	Online    bool      `json:"online"`
	Current   bool      `json:"current"`
	Secret    string    `json:"-"`
	Remember  bool      `json:"-"`
}

// Snapshot is private control-socket data. Never expose it through the web API.
type Snapshot struct {
	Token string            `json:"token"`
	Keys  map[string]string `json:"keys"`
}
type Event struct {
	State Snapshot
	Ack   chan error
}
type stream struct {
	session  [32]byte
	deviceID string
	close    func()
}

func Open(token, tokenPath, databasePath string) (*Manager, error) {
	m := New(token)
	m.tokenPath = tokenPath
	db, err := sql.Open("sqlite", databasePath)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	m.db = db
	if _, err = db.Exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, label TEXT NOT NULL, secret TEXT NOT NULL, generation TEXT NOT NULL, created TEXT NOT NULL, seen TEXT NOT NULL, remember INTEGER NOT NULL);`); err != nil {
		db.Close()
		return nil, err
	}
	if err = os.Chmod(databasePath, 0600); err != nil {
		db.Close()
		return nil, err
	}
	// A new token or a process restart invalidates temporary credentials.
	if _, err = db.Exec(`DELETE FROM devices WHERE generation != ? OR remember = 0`, m.generation()); err != nil {
		db.Close()
		return nil, err
	}
	rows, err := db.Query(`SELECT id,label,secret,created,seen,remember FROM devices`)
	if err != nil {
		db.Close()
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d Device
		var created, seen string
		if err = rows.Scan(&d.ID, &d.Label, &d.Secret, &created, &seen, &d.Remember); err != nil {
			db.Close()
			return nil, err
		}
		d.CreatedAt, err = time.Parse(time.RFC3339Nano, created)
		if err != nil {
			db.Close()
			return nil, err
		}
		d.LastSeen, err = time.Parse(time.RFC3339Nano, seen)
		if err != nil {
			db.Close()
			return nil, err
		}
		m.devices[d.ID] = d
	}
	return m, rows.Err()
}

func (m *Manager) Close() error {
	if m.db != nil {
		return m.db.Close()
	}
	return nil
}
func (m *Manager) generation() string { return hex.EncodeToString(m.token[:]) }

func (m *Manager) Token() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rawToken
}
func randomSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (m *Manager) LoginDevice(clientID, token, label string, remember bool) (Device, string, time.Time, error) {
	m.changeMu.Lock()
	defer m.changeMu.Unlock()
	session, expires, err := m.Login(clientID, token)
	if err != nil {
		return Device{}, "", time.Time{}, err
	}
	secret, err := randomSecret()
	if err != nil {
		m.Logout(session)
		return Device{}, "", time.Time{}, err
	}
	id, err := randomSecret()
	if err != nil {
		m.Logout(session)
		return Device{}, "", time.Time{}, err
	}
	label = strings.Join(strings.Fields(label), " ")
	if label == "" {
		label = "Browser"
	}
	if len([]rune(label)) > 120 {
		label = string([]rune(label)[:120])
	}
	m.mu.Lock()
	d := Device{ID: id, Secret: secret, Label: label, CreatedAt: m.now(), LastSeen: m.now(), Remember: remember}
	if m.db != nil {
		_, err = m.db.Exec(`INSERT INTO devices VALUES (?,?,?,?,?,?,?)`, d.ID, d.Label, d.Secret, m.generation(), d.CreatedAt.Format(time.RFC3339Nano), d.LastSeen.Format(time.RFC3339Nano), remember)
	}
	if err == nil {
		m.devices[id] = d
		m.owners[sha256.Sum256([]byte(session))] = id
	}
	m.mu.Unlock()
	if err != nil {
		m.Logout(session)
		return Device{}, "", time.Time{}, err
	}
	if err = m.publish(); err != nil {
		return Device{}, "", time.Time{}, err
	}
	return d, session, expires, nil
}

// Resume is private to the connector, which has already verified device-key possession.
func (m *Manager) Resume(id string) (string, time.Time, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.devices[id]; !ok {
		return "", time.Time{}, ErrInvalidCredentials
	}
	for hash, expiry := range m.sessions {
		if !expiry.After(m.now()) {
			delete(m.sessions, hash)
		}
	}
	session, err := randomSecret()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := m.now().Add(SessionDuration)
	hash := sha256.Sum256([]byte(session))
	m.sessions[hash] = expires
	m.owners[hash] = id
	return session, expires, nil
}

func (m *Manager) ResumeSecret(secret string) (string, time.Time, error) {
	if secret == "" {
		return "", time.Time{}, ErrInvalidCredentials
	}
	candidate := sha256.Sum256([]byte(secret))
	m.mu.Lock()
	id := ""
	for _, d := range m.devices {
		if d.Remember && sha256.Sum256([]byte(d.Secret)) == candidate {
			id = d.ID
			break
		}
	}
	m.mu.Unlock()
	return m.Resume(id)
}

// DeviceID resolves ownership, including expired sessions, for revocation.
// Callers granting access must independently check Valid.
func (m *Manager) DeviceID(session string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.owners[sha256.Sum256([]byte(session))]
}
func (m *Manager) Devices(session string) []Device {
	m.mu.Lock()
	defer m.mu.Unlock()
	current := m.owners[sha256.Sum256([]byte(session))]
	result := make([]Device, 0, len(m.devices))
	for _, d := range m.devices {
		d.Current = d.ID == current
		d.Online = m.now().Sub(d.LastSeen) < 45*time.Second
		result = append(result, d)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].CreatedAt.Before(result[j].CreatedAt) })
	return result
}
func (m *Manager) Touch(session string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := m.owners[sha256.Sum256([]byte(session))]
	d, ok := m.devices[id]
	if !ok {
		return ErrInvalidCredentials
	}
	if m.now().Sub(d.LastSeen) < 10*time.Second {
		return nil
	}
	d.LastSeen = m.now()
	if m.db != nil {
		if _, err := m.db.Exec(`UPDATE devices SET seen=? WHERE id=?`, d.LastSeen.Format(time.RFC3339Nano), id); err != nil {
			return err
		}
	}
	m.devices[id] = d
	return nil
}

var ErrInvalidDeviceLabel = errors.New("device name must contain 1–120 characters")
var ErrDeviceNotFound = errors.New("device not found")

func (m *Manager) RenameDevice(id, label string) error {
	label = strings.Join(strings.Fields(label), " ")
	if len([]rune(label)) < 1 || len([]rune(label)) > 120 {
		return ErrInvalidDeviceLabel
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.devices[id]
	if !ok {
		return ErrDeviceNotFound
	}
	if m.db != nil {
		if _, err := m.db.Exec(`UPDATE devices SET label=? WHERE id=?`, label, id); err != nil {
			return err
		}
	}
	d.Label = label
	m.devices[id] = d
	return nil
}

func (m *Manager) Revoke(id string) error {
	m.changeMu.Lock()
	defer m.changeMu.Unlock()
	m.mu.Lock()
	if m.db != nil {
		if _, err := m.db.Exec(`DELETE FROM devices WHERE id=?`, id); err != nil {
			m.mu.Unlock()
			return err
		}
	}
	delete(m.devices, id)
	for hash, owner := range m.owners {
		if owner == id {
			delete(m.sessions, hash)
			delete(m.owners, hash)
		}
	}
	m.closeDeviceStreamsLocked(id)
	m.mu.Unlock()
	return m.publish()
}

// Rotate persists first. Device generations make interruption between disk and
// memory updates safe on restart. A failed write leaves the old token untouched.
func (m *Manager) Rotate() (string, error) {
	m.changeMu.Lock()
	defer m.changeMu.Unlock()
	token, err := randomSecret()
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	if m.tokenPath != "" {
		err = AtomicToken(m.tokenPath, token)
	}
	if err != nil {
		data, readErr := os.ReadFile(m.tokenPath)
		if readErr != nil || strings.TrimSpace(string(data)) != token {
			m.mu.Unlock()
			return "", err
		}
	}
	persistenceErr := err
	m.rawToken = token
	m.token = sha256.Sum256([]byte(token))
	m.devices = make(map[string]Device)
	m.sessions = make(map[[32]byte]time.Time)
	m.owners = make(map[[32]byte]string)
	for id, stream := range m.streams {
		stream.close()
		delete(m.streams, id)
	}
	m.mu.Unlock()
	if err = m.publish(); err != nil {
		return token, err
	}
	return token, persistenceErr
}

func AtomicToken(path, token string) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".auth-token-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.WriteString(token + "\n")
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (m *Manager) Track(session string, closeFn func()) func() {
	m.mu.Lock()
	defer m.mu.Unlock()
	expires, ok := m.sessions[sha256.Sum256([]byte(session))]
	if !ok || !expires.After(m.now()) {
		closeFn()
		return func() {}
	}
	m.nextStream++
	id := m.nextStream
	hash := sha256.Sum256([]byte(session))
	m.streams[id] = stream{session: hash, deviceID: m.owners[hash], close: closeFn}
	return func() { m.mu.Lock(); delete(m.streams, id); m.mu.Unlock() }
}
func (m *Manager) closeDeviceStreamsLocked(deviceID string) {
	for id, s := range m.streams {
		if s.deviceID == deviceID {
			s.close()
			delete(m.streams, id)
		}
	}
}
func (m *Manager) snapshotLocked() Snapshot {
	s := Snapshot{Token: m.rawToken, Keys: make(map[string]string)}
	for id, d := range m.devices {
		s.Keys[id] = d.Secret
	}
	return s
}
func (m *Manager) Subscribe() (Snapshot, chan Event, func()) {
	m.mu.Lock()
	defer m.mu.Unlock()
	ch := make(chan Event, 1)
	m.watchers[ch] = true
	return m.snapshotLocked(), ch, func() { m.mu.Lock(); delete(m.watchers, ch); m.mu.Unlock() }
}
func (m *Manager) publish() error {
	m.mu.Lock()
	s := m.snapshotLocked()
	acks := make([]chan error, 0, len(m.watchers))
	for ch := range m.watchers {
		ack := make(chan error, 1)
		select {
		case ch <- Event{s, ack}:
			acks = append(acks, ack)
		default:
			m.mu.Unlock()
			return errors.New("authentication subscriber is unavailable")
		}
	}
	m.mu.Unlock()
	for _, ack := range acks {
		select {
		case err := <-ack:
			if err != nil {
				return err
			}
		case <-time.After(4 * time.Second):
			return errors.New("credentials changed, but connector revocation could not be confirmed")
		}
	}
	return nil
}
