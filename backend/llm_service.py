import os
import time
import functools

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
