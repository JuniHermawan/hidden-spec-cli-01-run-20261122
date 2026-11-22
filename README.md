# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

AI models write edits in several formats, and each one gets the details
wrong in its own way: unified diffs with wrong line numbers, drifted
whitespace and indentation, blank context lines without their leading
space, prose and code fences around the patch. `mend` applies those edits
to a tree of text files, exactly as `SPEC.md` says, in all four formats.
Every file is changed, or nothing is: edits apply in patch order, a failed
edit changes nothing and the edits after it still run, and when any edit
fails no file is written at all.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library only. No installs, no network, no model calls.

- `PATCH` is the patch file, relative to the working directory (the root
  of the tree). When it is absent or `-`, the patch is read from standard
  input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`. `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`
for a move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>`
line per failed edit and `failed: <k> of <n> edits`. Exit 2 prints a
single `error: ...` line for a usage error, an unreadable patch file, an
undetected format, or a patch that cannot be parsed.

## The four formats

- **Unified diff** — `diff --git`, `---`/`+++` headers (including rename,
  new and deleted files), and `@@` hunks. Hunks are matched by content,
  not by their (often wrong) line numbers: the occurrence nearest the
  hunk's stated position wins. Empty hunks insert; `\ No newline at end
  of file` is honoured; creates, deletes and moves are supported.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines,
  `=======`, new lines, `>>>>>>> REPLACE`. The path is the nearest
  non-blank, non-fence line above the block (or the previous block's
  path). An empty old block creates the file; an old block that occurs
  more than once is `ambiguous`.
- **V4A patches** — `*** Begin Patch` … `*** End Patch`, with `*** Add
  File:`, `*** Delete File:`, `*** Update File:` (optionally `*** Move
  to:`) sections. Update chunks start at `@@ <anchor>` lines or at a body
  line, apply in order with a cursor that moves past each chunk, and a
  `*** End of File` line anchors a chunk to the end of the file.
- **JSON edits** — one JSON array of edit objects, or JSON Lines with one
  edit object per line: `create`, `str_replace` (exactly once, exact
  match) and `insert` (by line number), with CRLF files handled.

## Matching

Old lines are found at the first of three tiers at which they occur:
exact (tier 0), trailing-whitespace-insensitive (tier 1), then
leading-and-trailing-whitespace-insensitive (tier 2). Context lines are
written as the file's own matched lines, and at tier 2 the other new
lines are re-indented from the old lines' indentation to the file's. A
file keeps its own line breaks (CRLF or LF) and its final line break,
unless the format says otherwise; a file an edit creates uses LF.

## The files

- `main.ts` — the whole tool.
- `runner.ts` — the kit's trial runner (unchanged).
- `check.ts` — run the practice set: `node check.ts <practice.json>`.
- `SPEC.md` — the full specification; every sentence in it is a
  requirement, and this tool implements it sentence by sentence.

---

Built for the [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty on make.fun.

https://make.fun/?ref=yspfqw66
