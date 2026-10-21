.DEFAULT_GOAL := help
.PHONY: help setup db build run codex start demo dev web check test smoke-codex

# Keep the root commands compatible; the example's commands live in demo/.
help setup db build run codex start demo dev web check test smoke-codex:
	$(MAKE) -C demo $@
