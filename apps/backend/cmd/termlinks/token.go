package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	qrcode "github.com/skip2/go-qrcode"
	"golang.org/x/term"
	"termlinks/backend/internal/auth"
	"termlinks/backend/internal/client"
	"termlinks/backend/internal/config"
)

func tokenQRPayload(token, portal string) (string, error) {
	if portal == "" {
		return token, nil
	}
	parsed, err := url.Parse(strings.TrimSpace(portal))
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("portal URL must be an http(s) URL without credentials, query or fragment")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/"
	parsed.Fragment = "termlinks-token=" + url.QueryEscape(token) + "&v=1"
	return parsed.String(), nil
}

func printToken(args []string) error {
	flags := flag.NewFlagSet("token", flag.ContinueOnError)
	rotate := flags.Bool("rotate", false, "replace the token and revoke every device")
	portalURL := flags.String("url", "", "save the phone-accessible portal URL for QR login")
	noQR := flags.Bool("no-qr", false, "print only the token")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("usage: termlinks token [--rotate] [--url <portal-url>] [--no-qr]")
	}
	paths, err := config.ResolvePaths()
	if err != nil {
		return err
	}
	if err = config.Ensure(paths); err != nil {
		return err
	}
	portalPath := filepath.Join(paths.Dir, "portal.url")
	if *portalURL != "" {
		if _, err = tokenQRPayload("validation", *portalURL); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	control := client.New(paths.Socket)
	var token string
	if control.Healthy(ctx) {
		token, err = control.PortalToken(ctx, *rotate)
		if err != nil {
			return fmt.Errorf("token operation failed; a running older daemon needs an upgrade after its active terminals finish: %w", err)
		}
	} else {
		unlock, lockErr := config.LockAuth(paths)
		if lockErr != nil {
			return lockErr
		}
		defer unlock()
		// An older daemon may not own auth.lock. Never rotate behind its back.
		connection, dialErr := net.DialTimeout("unix", paths.Socket, time.Second)
		if dialErr == nil {
			connection.Close()
			return errors.New("daemon is running but its control API is unavailable; stop or upgrade it before changing credentials")
		}
		if !errors.Is(dialErr, os.ErrNotExist) && !errors.Is(dialErr, syscall.ECONNREFUSED) {
			return fmt.Errorf("could not establish that the daemon is stopped: %w", dialErr)
		}
		token, err = config.LoadOrCreateToken(paths)
		if err != nil {
			return err
		}
		if *rotate {
			manager, openErr := auth.Open(token, paths.Token, filepath.Join(paths.Dir, "devices.db"))
			if openErr != nil {
				return openErr
			}
			defer manager.Close()
			token, err = manager.Rotate()
			if err != nil {
				return err
			}
		}
	}
	if *portalURL != "" {
		if err = auth.AtomicToken(portalPath, strings.TrimSpace(*portalURL)); err != nil {
			return err
		}
	} else if data, readErr := os.ReadFile(portalPath); readErr == nil {
		*portalURL = strings.TrimSpace(string(data))
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	payload, err := tokenQRPayload(token, *portalURL)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, token)
	if *rotate {
		fmt.Fprintln(os.Stderr, "Token rotated. All previous device credentials are revoked. Sign in again with this token.")
	}
	if !*noQR && term.IsTerminal(int(os.Stdout.Fd())) {
		code, qrErr := qrcode.New(payload, qrcode.Medium)
		if qrErr != nil {
			return qrErr
		}
		fmt.Fprintln(os.Stderr, code.ToSmallString(false))
		if *portalURL == "" {
			fmt.Fprintln(os.Stderr, "Scan in Termlinks. To open the portal from your phone camera, run: termlinks token --url https://<your-portal>")
		} else {
			fmt.Fprintln(os.Stderr, "Scan to connect:", *portalURL)
		}
	}
	fmt.Fprintln(os.Stderr, "Keep this token and QR code private.")
	return nil
}
