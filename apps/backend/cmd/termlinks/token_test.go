package main

import (
	"net/url"
	"strings"
	"testing"

	qrcode "github.com/skip2/go-qrcode"
)

func TestTokenQRPayload(t *testing.T) {
	token := strings.Repeat("a", 43)
	payload, err := tokenQRPayload(token, "")
	if err != nil || payload != token {
		t.Fatal("token-only QR failed")
	}
	payload, err = tokenQRPayload(token, "https://portal.example")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(payload)
	if err != nil {
		t.Fatal(err)
	}
	fragment, _ := url.ParseQuery(parsed.Fragment)
	if parsed.RawQuery != "" || fragment.Get("termlinks-token") != token || fragment.Get("v") != "1" {
		t.Fatal("token was not encoded in fragment")
	}
	code, err := qrcode.New(payload, qrcode.Medium)
	if err != nil || code.ToSmallString(false) == "" {
		t.Fatal("terminal QR generation failed")
	}
	for _, bad := range []string{"javascript:alert(1)", "https://user:pass@portal.example", "https://portal.example/?token=x", "/relative"} {
		if _, err := tokenQRPayload(token, bad); err == nil {
			t.Fatalf("accepted invalid URL %s", bad)
		}
	}
}
