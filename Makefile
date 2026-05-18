.PHONY: test build clean

test:
	npm test

build:
	rm -rf ./dist || true
	npm run build

clean:
	rm -rf dist/
./