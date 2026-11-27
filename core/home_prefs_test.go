package main

import (
	"slices"
	"strings"
	"testing"
)

func TestSanitizeHomePrefKeys(t *testing.T) {
	got, err := sanitizeHomePrefKeys([]string{" builtin:contacts ", "vocab", "vocab", "", "  ", "builtin:settings"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want := []string{"builtin:contacts", "vocab", "builtin:settings"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}

	tooLong := strings.Repeat("a", maxHomePrefKeyLen+1)
	if _, err := sanitizeHomePrefKeys([]string{tooLong}); err == nil {
		t.Fatal("expected error for overlong key")
	}

	tooMany := make([]string, maxHomePrefItems+1)
	for i := range tooMany {
		tooMany[i] = "a"
	}
	if _, err := sanitizeHomePrefKeys(tooMany); err == nil {
		t.Fatal("expected error for too many keys")
	}
}
