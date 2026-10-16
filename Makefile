.PHONY: check accept accept-1 accept-2 accept-3 accept-4 install typecheck test build-web e2e-ui serve

install:
	bun install --frozen-lockfile --ignore-scripts

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

accept-4:
	bash scripts/accept/wave-4.sh

build-web:
	bun run build:web

e2e-ui: build-web
	bun run e2e:ui

serve:
	bun run serve

accept: accept-1 accept-2 accept-3 accept-4
