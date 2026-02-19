# Security Rules

Activated when working with authentication, secrets, or security-sensitive code.

- Never hardcode secrets, API keys, or passwords in source code
- Use environment variables or secret management for credentials
- Validate and sanitize all user input before processing
- Use parameterized queries - never concatenate SQL strings
- Apply the principle of least privilege for permissions and access
- Log security-relevant events but never log sensitive data
- Use HTTPS for all external API calls
- Set appropriate CORS headers - avoid wildcard origins in production
- Hash passwords with bcrypt or argon2 - never store plaintext
- Verify JWT signatures and check expiration on every request
