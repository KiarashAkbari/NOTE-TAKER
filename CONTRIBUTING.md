# Contributing to NOTE-TAKER

Thanks for your interest! This is a small vanilla HTML/CSS/JS project with no build step.

## Getting started

1. Fork the repo and clone it.
2. Serve the folder (e.g. `python3 -m http.server 8000`) and open
   `http://localhost:8000`. Opening `index.html` directly works for notes,
   tasks, tags and themes, but Google OAuth rejects `file://` origins, so the
   sync button cannot complete from a `file://` URL.
3. Create a branch: `git checkout -b feature/your-change`.

## Guidelines

- Keep it framework-free (vanilla JavaScript).
- Keep the dark, minimal UI style consistent.
- Test in at least one Chromium browser and Firefox.
- Write clear commit messages and open a pull request against `main`.

## Reporting bugs

Open an issue with steps to reproduce, expected vs. actual behavior, and your browser.

## License

By contributing, you agree your contributions are licensed under the MIT License.
