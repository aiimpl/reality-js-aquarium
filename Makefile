PORT ?= 8797
PY ?= .venv/bin/python
DUR ?= 18.2667

.PHONY: serve setup frames video clean

serve:
	python3 -m http.server $(PORT) --bind 127.0.0.1

setup:
	python3 -m venv .venv
	.venv/bin/pip install -r requirements.txt

# start a server in the background and export 548 frames (bake ~1.5 min, then ~0.4 s per frame on Apple silicon)
frames:
	python3 -m http.server $(PORT) --bind 127.0.0.1 >/dev/null 2>&1 & echo $$! > build.pid; \
	sleep 1; URL=http://127.0.0.1:$(PORT)/index.html?render $(PY) tools/render.py build/frames --range 0 $(DUR) 30; \
	kill `cat build.pid`; rm -f build.pid

video: frames
	tools/encode.sh build/frames build/aquarium.mp4

clean:
	rm -rf build
