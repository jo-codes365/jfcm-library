FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    LIBREOFFICE_BINARY=/usr/bin/libreoffice

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        fontconfig \
        fonts-dejavu-core \
        fonts-liberation \
        libreoffice \
    && libreoffice --headless --version \
    && command -v libreoffice \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY . .

EXPOSE 8000

CMD ["/bin/sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT:-8000} --access-logfile - --error-logfile - app:app"]
