import os
import re
import json
import time
import functools

from models import Era

# LLM Configuration
LLM_PROVIDER = os.getenv('LLM_PROVIDER', 'openai')
LLM_TIMEOUT = int(os.getenv('LLM_TIMEOUT', '30'))

# Default models per provider
DEFAULT_MODELS = {
    'openai': 'gpt-4o-mini',
    'anthropic': 'claude-3-haiku-20240307'
}

LLM_MODEL = os.getenv('LLM_MODEL', DEFAULT_MODELS.get(LLM_PROVIDER, 'gpt-4o-mini'))

# Client cache
_client = None


def get_client():
    """Get or create the LLM client based on provider configuration."""
    global _client

    if _client is not None:
        return _client

    if LLM_PROVIDER == 'openai':
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            raise ValueError("OPENAI_API_KEY environment variable not set")

        from openai import OpenAI
        _client = OpenAI(api_key=api_key, timeout=LLM_TIMEOUT)

    elif LLM_PROVIDER == 'anthropic':
        api_key = os.getenv('ANTHROPIC_API_KEY')
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable not set")

        from anthropic import Anthropic
        _client = Anthropic(api_key=api_key, timeout=LLM_TIMEOUT)

    else:
        raise ValueError(f"Unknown LLM provider: {LLM_PROVIDER}")

    return _client


def retry_with_backoff(max_retries=3, base_delay=1):
    """Decorator for retrying functions with exponential backoff."""
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            last_exception = None

            for attempt in range(max_retries):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    last_exception = e
                    error_str = str(e).lower()

                    # Check if it's a retryable error
                    retryable = any(term in error_str for term in [
                        'rate limit', 'timeout', 'connection',
                        'server error', '500', '502', '503', '529'
                    ])

                    if not retryable or attempt == max_retries - 1:
                        raise

                    # Exponential backoff: 1s, 2s, 4s
                    delay = base_delay * (2 ** attempt)
                    time.sleep(delay)

            raise last_exception

        return wrapper
    return decorator


def format_duration(days: int) -> str:
    """Format duration in days to human-readable string."""
    if days < 14:
        return f"{days} days"
    elif days < 60:
        weeks = days // 7
        return f"{weeks} week{'s' if weeks != 1 else ''}"
    else:
        months = days // 30
        return f"{months} month{'s' if months != 1 else ''}"


def build_era_prompt(era: Era) -> str:
    """
    Build a prompt for the LLM to name and summarize an era.

    Args:
        era: Era object with listening data

    Returns:
        Formatted prompt string
    """
    # Format date range
    start_month = era.start_date.strftime("%B %Y")
    end_month = era.end_date.strftime("%B %Y")
    if start_month == end_month:
        date_range = start_month
    else:
        date_range = f"{start_month} - {end_month}"

    # Calculate duration
    duration_days = (era.end_date - era.start_date).days + 1
    duration = format_duration(duration_days)

    # Format listening time
    hours = era.total_ms_played // 3600000
    listening_time = f"{hours} hour{'s' if hours != 1 else ''}"

    # Format top 5 artists
    artists_lines = []
    for i, (artist, count) in enumerate(era.top_artists[:5], 1):
        artists_lines.append(f"{i}. {artist} ({count} plays)")
    formatted_artists = "\n".join(artists_lines)

    # Format top 10 tracks
    tracks_lines = []
    for i, (track, artist, count) in enumerate(era.top_tracks[:10], 1):
        tracks_lines.append(f"{i}. {track} by {artist} ({count} plays)")
    formatted_tracks = "\n".join(tracks_lines)

    prompt = f"""You are analyzing someone's music listening history. Based on this era's data, create a creative title and summary.

Era: {date_range} ({duration})
Total listening time: {listening_time}

Top Artists:
{formatted_artists}

Top Tracks:
{formatted_tracks}

Create a JSON response with:
- "title": A creative, evocative 2-5 word title that captures the mood/vibe. Avoid generic titles like "Musical Journey", "Eclectic Mix", or "Summer Vibes".
- "summary": A 2-3 sentence summary describing the musical mood, themes, or story of this era.

Respond ONLY with valid JSON: {{"title": "...", "summary": "..."}}"""

    return prompt


def get_fallback_response(era: Era) -> dict:
    """Generate fallback title and summary when LLM fails."""
    month_year = era.start_date.strftime("%B %Y")
    duration_days = (era.end_date - era.start_date).days + 1
    duration = format_duration(duration_days)

    top_artist = era.top_artists[0][0] if era.top_artists else "various artists"

    return {
        "title": f"Era {era.id}: {month_year}",
        "summary": f"A {duration} period featuring {top_artist} and more."
    }


def parse_llm_response(response_text: str) -> dict:
    """
    Parse LLM response to extract JSON.

    Args:
        response_text: Raw response from LLM

    Returns:
        Parsed dict with title and summary, or None if parsing fails
    """
    # Try direct JSON parse first
    try:
        return json.loads(response_text)
    except json.JSONDecodeError:
        pass

    # Try to extract JSON from response using regex
    match = re.search(r'\{.*\}', response_text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    return None


@retry_with_backoff(max_retries=3, base_delay=1)
def call_llm(prompt: str) -> str:
    """
    Call the LLM API with the given prompt.

    Args:
        prompt: The prompt to send

    Returns:
        Response text from the LLM
    """
    client = get_client()

    if LLM_PROVIDER == 'openai':
        response = client.chat.completions.create(
            model=LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
            max_tokens=300
        )
        return response.choices[0].message.content

    elif LLM_PROVIDER == 'anthropic':
        response = client.messages.create(
            model=LLM_MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
            max_tokens=300
        )
        return response.content[0].text

    else:
        raise ValueError(f"Unknown LLM provider: {LLM_PROVIDER}")


def name_era(era: Era) -> dict:
    """
    Generate a title and summary for an era using LLM.

    Args:
        era: Era object with listening data

    Returns:
        Dict with "title" and "summary" keys
    """
    try:
        prompt = build_era_prompt(era)
        response_text = call_llm(prompt)
        parsed = parse_llm_response(response_text)

        if parsed and "title" in parsed and "summary" in parsed:
            return parsed

        # Parsing failed, use fallback
        return get_fallback_response(era)

    except Exception:
        # Any error, use fallback
        return get_fallback_response(era)
