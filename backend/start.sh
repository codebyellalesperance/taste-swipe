#!/bin/bash
# Production startup script for TasteSwipe Backend

# Exit on error
set -e

echo "Starting TasteSwipe Backend..."

# Check if .env exists
if [ ! -f .env ]; then
    echo "ERROR: .env file not found!"
    echo "Copy .env.example to .env and configure your environment variables."
    exit 1
fi

# Check required environment variables
required_vars=("SPOTIFY_CLIENT_ID" "SPOTIFY_CLIENT_SECRET" "SECRET_KEY" "OPENAI_API_KEY")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "ERROR: $var not set in environment!"
        exit 1
    fi
done

# Install dependencies
echo "Installing dependencies..."
pip3 install -r requirements.txt

# Run migrations (if database is added later)
# python3 manage.py migrate

# Start with Gunicorn in production
if [ "$FLASK_ENV" = "production" ]; then
    echo "Starting with Gunicorn (Production mode)..."
    exec gunicorn -c gunicorn_config.py app:app
else
    echo "Starting with Flask dev server (Development mode)..."
    exec python3 app.py
fi
