package main

import "testing"

func TestNormalizeOpenMode(t *testing.T) {
	if got := normalizeOpenMode(""); got != openModePortal {
		t.Fatalf("empty mode = %q, want %q", got, openModePortal)
	}
	if got := normalizeOpenMode(openModePortal); got != openModePortal {
		t.Fatalf("portal mode = %q, want %q", got, openModePortal)
	}
	if got := normalizeOpenMode(openModeNewTab); got != openModeNewTab {
		t.Fatalf("new-tab mode = %q, want %q", got, openModeNewTab)
	}
	if got := normalizeOpenMode("unknown"); got != openModePortal {
		t.Fatalf("unknown mode = %q, want %q", got, openModePortal)
	}
}
