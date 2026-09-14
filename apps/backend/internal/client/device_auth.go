package client

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"termlinks/backend/internal/auth"
)

type DeviceLogin struct {
	Token    string `json:"token,omitempty"`
	DeviceID string `json:"deviceId,omitempty"`
	Label    string `json:"label,omitempty"`
	Remember bool   `json:"remember"`
}
type DeviceLoginResult struct {
	DeviceID string `json:"deviceId"`
	Secret   string `json:"secret"`
	Session  string `json:"session"`
}

func (c *Client) PortalToken(ctx context.Context, rotate bool) (string, error) {
	method, path := "GET", "/v1/auth/token"
	if rotate {
		method, path = "POST", "/v1/auth/rotate"
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://termlinks.local"+path, nil)
	if err != nil {
		return "", err
	}
	var result struct {
		Token string `json:"token"`
	}
	err = c.authJSON(request, &result)
	return result.Token, err
}
func (c *Client) LoginDevice(ctx context.Context, input DeviceLogin) (DeviceLoginResult, error) {
	body, err := json.Marshal(input)
	if err != nil {
		return DeviceLoginResult{}, err
	}
	request, err := http.NewRequestWithContext(ctx, "POST", "http://termlinks.local/v1/auth/login", bytes.NewReader(body))
	if err != nil {
		return DeviceLoginResult{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	var result DeviceLoginResult
	err = c.authJSON(request, &result)
	return result, err
}

// WatchAuth must remain live for the connector to accept any browser access.
func (c *Client) WatchAuth(ctx context.Context, apply func(auth.Snapshot)) error {
	dialer := websocket.Dialer{HandshakeTimeout: 3 * time.Second, NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", c.socket)
	}}
	connection, _, err := dialer.DialContext(ctx, "ws://termlinks.local/v1/auth/events", nil)
	if err != nil {
		return err
	}
	defer connection.Close()
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			connection.Close()
		case <-done:
		}
	}()
	connection.SetReadLimit(1 << 20)
	for {
		_ = connection.SetReadDeadline(time.Now().Add(4 * time.Second))
		var snapshot auth.Snapshot
		if err := connection.ReadJSON(&snapshot); err != nil {
			return err
		}
		apply(snapshot)
		_ = connection.SetWriteDeadline(time.Now().Add(time.Second))
		if err := connection.WriteJSON(map[string]bool{"ack": true}); err != nil {
			return err
		}
	}
}

func (c *Client) authJSON(request *http.Request, output any) error {
	clone := *c
	httpClient := *c.http
	httpClient.Timeout = 8 * time.Second
	clone.http = &httpClient
	return clone.doJSON(request, output)
}
