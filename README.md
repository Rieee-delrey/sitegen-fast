# sitegen-fast

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/rieee-delrey/sitegen-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/rieee-delrey/sitegen-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0. `run(input)` returns
exactly what makefun-site returns for every case, byte for byte, but faster.

The reference walks every Markdown source character by character and
rebuilds strings by appending one piece at a time. This one jumps from
special character to special character instead: a single-pass lexer with
no token array, a run-sliced inline renderer that copies plain runs out
raw, a substring front-matter parser, a slug cache with a pure-ASCII fast
path, and templates compiled once per case into plain JavaScript with
includes inlined and loop objects skipped when the subtree never reads
them.

`main.ts` is the house driver unchanged: it reads `/input/cases.json`,
answers each case with `run`, and writes `/output/answers.json`.

## Benchmark (local, practice set, 3 cases)

Interleaved A/B in one process, CPU time, trimmed mean of 9 rounds
(grader-style), Node with `--no-incremental-marking` as the driver runs:

| generator | CPU time |
| --- | --- |
| makefun-site 1.0.0 (house baseline) | ~500 ms |
| this entry | ~160 ms |
| speedup | ~3.1x |

Correctness: identical answers to makefun-site 1.0.0 on all 3 practice
cases, on 21 freshly drawn generator cases, and on a 15-case hand-made
edge suite (refusals, slug collisions, Unicode slugs, duplicate tag
slugs, missing tag template, no posts, shadowed statics, all link kinds,
Markdown block and inline corners, broken templates, include depth,
empty inputs). Determinism verified over two runs.
