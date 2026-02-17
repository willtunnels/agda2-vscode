#!/usr/bin/env python3
"""
Generate src/unicode/abbreviations.json from the installed Agda input method.

Uses Emacs in batch mode to load agda-input.el (which inherits from the TeX
Quail package), then dumps the fully-resolved translation table as JSON.

Requirements:
  - emacs  (any recent version with quail and json support)
  - agda   (specifically `agda-mode locate` to find agda-input.el)

Usage:
  python3 scripts/generate-abbreviations.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

# Elisp script that dumps all Agda input translations as JSON to stdout.
# Expects agda-input.el to already be loaded via -l flag (which triggers
# agda-input-setup automatically at load time).
DUMP_ELISP = r"""
(require 'json)
(require 'cl-lib)

(defun dump-agda-translations ()
  "Dump all Agda input translations as a JSON object to stdout.
Keys include the leading backslash (from agda-input-tweak-all).
Values are arrays of translation strings, filtered to exclude
entries where every translation is a single printable ASCII character."
  (let ((translations (agda-input-get-translations "Agda"))
        (table (make-hash-table :test 'equal)))
    (dolist (pair translations)
      (let* ((key (car pair))
             (val (cdr pair))
             (strings
              (cond
               ((vectorp val)
                (mapcar (lambda (x)
                          (cond
                           ((stringp x) x)
                           ((characterp x) (string x))
                           ((symbolp x) (symbol-name x))
                           (t (format "%s" x))))
                        (append val nil)))
               ((stringp val) (list val))
               ((characterp val) (list (string val)))
               (t (list (format "%s" val))))))
        (when (and (> (length key) 0) strings)
          (let ((non-ascii-translations
                 (cl-remove-if
                  (lambda (s)
                    (and (= (length s) 1)
                         (let ((c (aref s 0)))
                           (and (>= c #x20) (<= c #x7e)))))
                  strings)))
            (when non-ascii-translations
              (puthash key (vconcat non-ascii-translations) table))))))
    (let ((json-encoding-pretty-print nil))
      (princ (json-encode table))
      (princ "\n"))))

(dump-agda-translations)
"""


def find_executable(name: str) -> str:
    path = shutil.which(name)
    if not path:
        print(f"error: '{name}' not found in PATH", file=sys.stderr)
        sys.exit(1)
    return path


def find_agda_input_el() -> str:
    """Use `agda-mode locate` to find the Agda emacs-mode directory,
    then return the path to agda-input.el."""
    agda_mode = find_executable("agda-mode")
    try:
        result = subprocess.run(
            [agda_mode, "locate"],
            capture_output=True, text=True, check=True,
        )
    except subprocess.CalledProcessError as e:
        print(f"error: `agda-mode locate` failed: {e.stderr}", file=sys.stderr)
        sys.exit(1)

    agda2_el = result.stdout.strip()
    emacs_mode_dir = os.path.dirname(agda2_el)
    agda_input_el = os.path.join(emacs_mode_dir, "agda-input.el")

    if not os.path.isfile(agda_input_el):
        print(f"error: agda-input.el not found at {agda_input_el}", file=sys.stderr)
        sys.exit(1)

    return agda_input_el


def dump_raw_translations(emacs: str, agda_input_el: str) -> dict:
    """Run Emacs in batch mode to load agda-input.el and dump all
    translations as JSON."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".el", delete=False,
    ) as f:
        f.write(DUMP_ELISP)
        dump_el = f.name

    try:
        result = subprocess.run(
            [emacs, "--batch", "-l", agda_input_el, "-l", dump_el],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        print("error: emacs timed out after 30 seconds", file=sys.stderr)
        sys.exit(1)
    finally:
        os.unlink(dump_el)

    if result.returncode != 0:
        # Emacs --batch often writes warnings to stderr even on success;
        # only fail if stdout is empty.
        pass

    stdout = result.stdout.strip()
    if not stdout:
        print("error: emacs produced no output", file=sys.stderr)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        sys.exit(1)

    try:
        return json.loads(stdout)
    except json.JSONDecodeError as e:
        print(f"error: failed to parse emacs JSON output: {e}", file=sys.stderr)
        print(f"first 500 chars: {stdout[:500]}", file=sys.stderr)
        sys.exit(1)


def postprocess(raw: dict) -> dict:
    """Strip the leading backslash from keys and sort."""
    cleaned = {}
    for key, translations in raw.items():
        # agda-input-tweak-all prepends \ to every key
        stripped = key[1:] if key.startswith("\\") else key
        if stripped and stripped.strip():
            # Skip whitespace-only keys (e.g. " " → NBSP). In Emacs agda-mode,
            # space deactivates the input method so these are unreachable via
            # normal typing. In our VS Code engine, they would prevent space
            # from finalizing the abbreviation.
            cleaned[stripped] = translations
    return dict(sorted(cleaned.items()))


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    output_dir = os.path.join(project_root, "src", "unicode")
    output_path = os.path.join(output_dir, "abbreviations.json")

    emacs = find_executable("emacs")
    agda_input_el = find_agda_input_el()

    print(f"Using emacs:          {emacs}")
    print(f"Using agda-input.el:  {agda_input_el}")

    raw = dump_raw_translations(emacs, agda_input_el)
    print(f"Raw translations:     {len(raw)}")

    cleaned = postprocess(raw)

    single = sum(1 for v in cleaned.values() if len(v) == 1)
    multi = sum(1 for v in cleaned.values() if len(v) > 1)
    print(f"After postprocessing: {len(cleaned)} ({single} single, {multi} multi)")

    os.makedirs(output_dir, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    print(f"Wrote:                {output_path}")


if __name__ == "__main__":
    main()
