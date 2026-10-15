.PHONY: check accept accept-1 accept-2 accept-3 install typecheck test

install:
	bun install

typecheck:
	bun run check

test:
	bun test

check: install typecheck test

accept-1:
	bash scripts/accept/wave-1.sh

accept-2:
	bash scripts/accept/wave-2.sh

accept-3:
	bash scripts/accept/wave-3.sh

accept: accept-1 accept-2 accept-3
