FROM jrottenberg/ffmpeg:6.1-alpine

RUN apk add --no-cache bash coreutils procps python3 py3-pip
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY manager.py /work/manager.py
WORKDIR /work
