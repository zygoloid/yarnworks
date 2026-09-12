#!/usr/bin/env python3
"""Static file server for development that tells browsers not to cache.

Python's default http.server sends Last-Modified headers, which lets browsers
reuse old JavaScript modules after a plain reload. Run this instead:

    python3 serve.py [port]
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f'Serving on http://localhost:{port}/ (no caching)')
    ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
