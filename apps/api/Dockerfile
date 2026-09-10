FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ffmpeg aria2 unzip && rm -rf /var/lib/apt/lists/*

# yt-dlp 가 유튜브 주소를 풀려면 자바스크립트를 돌려야 한다. 없으면 대체 클라이언트로
# 폴백하는데(visionos player API), 그쪽은 포맷이 빠지거나 아예 실패한다.
# yt-dlp 가 기본으로 켜 두는 런타임이 deno 뿐이라 그걸 넣는다.
ENV DENO_INSTALL=/usr/local
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y --no-modify-path \
    && /usr/local/bin/deno --version

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN pip install --no-cache-dir --no-deps mplbasketball==1.0.1

COPY app ./app

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
