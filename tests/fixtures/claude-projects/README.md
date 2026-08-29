# Claude helper fixtures

`tests/claude.test.mjs` creates disposable Git repositories from these documented cases so no `.git`
directory or remote credential is included in the repository. The cases cover an `origin` remote, no
remotes, non-`origin` remotes, and multiple `origin` URLs.
