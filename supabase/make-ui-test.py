"""Builds a throwaway copy of the app that runs against the mock Supabase.

The real app.html is left alone: this writes _cloudmode-test.html next to it with
two changes — the inert cloud-config.js is swapped for the mock server plus test
keys, and browser storage is cleared on load so each run starts clean.

    python supabase/make-ui-test.py            # then open /_cloudmode-test.html
    python supabase/make-ui-test.py m.html     # the phone build

Nothing here belongs in a deployment; the generated file is git-ignored.
"""
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
src = REPO / (sys.argv[1] if len(sys.argv) > 1 else "app.html")
out = REPO / "_cloudmode-test.html"

html = src.read_text(encoding="utf-8")

CONFIG_TAG = '<script src="cloud-config.js"></script>'
assert html.count(CONFIG_TAG) == 1, f"{src.name}: expected exactly one cloud-config.js tag"
html = html.replace(CONFIG_TAG, (
    '<script src="supabase/mock-supabase.js"></script>\n'
    "<script>window.SB_CLOUD_CONFIG = { url: 'https://mock.supabase.co', anonKey: 'anon-key-123' };</script>"
))

# A clean slate, so a previous run's account or data cannot explain a result.
assert html.count("<head>") == 1
html = html.replace("<head>", (
    "<head>\n<script>try { localStorage.clear(); } catch (e) {}</script>"
), 1)

out.write_text(html, encoding="utf-8")
print(f"{out.name} built from {src.name} ({len(html) // 1024} KB)")
