package config

import (
	"fmt"
	"golang.org/x/sys/unix"
	"os"
	"path/filepath"
)

// The daemon holds this lock for its lifetime. Offline token commands must
// acquire it before changing credentials, including during daemon startup.
func LockAuth(paths Paths) (func(), error) {
	file, err := os.OpenFile(filepath.Join(paths.Dir, "auth.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, fmt.Errorf("authentication is owned by a running service or token command; retry after it is ready: %w", err)
	}
	return func() { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN); _ = file.Close() }, nil
}
