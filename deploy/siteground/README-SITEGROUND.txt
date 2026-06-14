CHOIR PRIVATE AREA - SITEGROUND / PHP DEPLOYMENT

Instructions:

1. In SiteGround > Site Tools > Domain > Subdomains, create your private subdomain.
   Example:
   privado.example.com

2. Find the document root for that subdomain.
   It is usually something like:
   public_html/privado

3. Upload everything in this folder to the subdomain root:
   .htaccess
   api.php
   config.example.php
   data/
   public/

4. Rename or copy:
   config.example.php -> config.php

5. Edit config.php with your real values:
   - app_base_url
   - app_name
   - app_secret
   - Ghost URL/API key/label, or replace the auth code
   - admin emails
   - Mailgun settings

6. Check permissions:
   - data/db.json must be writable by PHP.
   - .htaccess blocks direct access to JSON and config.php.

7. Open:
   https://your-private-subdomain.example/api/health

   Expected:
   {"ok":true}

8. Open:
   https://your-private-subdomain.example

9. Test login with an admin email.

Notes:

- Do not commit config.php to a public repository.
- This PHP version is intended for shared hosting where a long-running Node process is not available.
- Data is stored in data/db.json.
