# Nginx Configuration

Nginx reverse proxy and web server configuration for the Medical Billing System. Handles routing, load balancing, and static file serving.

## 📁 Files

```
nginx/
└── nginx.conf          # Main nginx configuration
```

## 🔧 Configuration Overview

This Nginx configuration provides:

- **Reverse Proxy**: Routes requests to backend and frontend services
- **Load Balancing**: Distributes requests across multiple backend instances
- **Static File Serving**: Efficiently serves frontend assets
- **Compression**: Gzip compression for faster response times
- **Security Headers**: Adds security-related HTTP headers
- **SSL/TLS**: Ready for HTTPS configuration

## 🚀 Setup

### Using Docker Compose (Recommended)

```bash
# Start nginx with other services
docker-compose up -d

# View logs
docker-compose logs -f nginx
```

### Running Standalone

```bash
# Using Docker
docker run -p 80:80 -p 443:443 \
  -v $(pwd)/nginx.conf:/etc/nginx/nginx.conf:ro \
  nginx:latest

# Using local Nginx installation
nginx -c /path/to/nginx.conf

# Check configuration validity
nginx -t -c /path/to/nginx.conf
```

## 📚 Configuration Details

### Upstream Backend

```nginx
upstream backend {
    server backend:5000;
    # Add more backend servers for load balancing
    # server backend2:5000;
    # server backend3:5000;
}
```

Defines the backend server pool for API requests.

### Server Blocks

#### Main Server (Port 80)

```nginx
server {
    listen 80;
    server_name localhost;

    # ... configuration
}
```

Main server block handling HTTP requests on port 80.

### Route Configuration

#### Frontend Routes

```nginx
location / {
    proxy_pass http://frontend:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
}
```

Serves the React frontend application.

#### API Routes

```nginx
location /api/ {
    proxy_pass http://backend:5000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90;
}
```

Routes API requests to the backend service.

#### Static Files

```nginx
location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

Caches static assets for optimal performance.

### Security Headers

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "no-referrer-when-downgrade" always;
add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;
```

Adds security headers to protect against common vulnerabilities.

### Performance Optimization

#### Gzip Compression

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css text/xml text/javascript
           application/x-javascript application/xml+rss
           application/javascript application/json;
```

Enables gzip compression for text-based responses.

#### Buffering

```nginx
proxy_buffering on;
proxy_buffer_size 4k;
proxy_buffers 8 4k;
proxy_busy_buffers_size 8k;
```

Optimizes proxy buffering for performance.

## 🔄 Load Balancing

### Round Robin (Default)

```nginx
upstream backend {
    server backend1:5000;
    server backend2:5000;
    server backend3:5000;
}
```

Distributes requests equally across servers.

### Weighted Round Robin

```nginx
upstream backend {
    server backend1:5000 weight=5;
    server backend2:5000 weight=3;
    server backend3:5000 weight=1;
}
```

Distributes based on weight ratio.

### Least Connections

```nginx
upstream backend {
    least_conn;
    server backend1:5000;
    server backend2:5000;
    server backend3:5000;
}
```

Routes to server with fewest active connections.

### Health Checks

```nginx
upstream backend {
    server backend1:5000 max_fails=3 fail_timeout=30s;
    server backend2:5000 max_fails=3 fail_timeout=30s;
}
```

Monitors server health and marks as down after failures.

## 🔐 HTTPS/SSL Configuration

### Basic SSL Setup

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate /etc/nginx/ssl/cert.pem;
    ssl_certificate_key /etc/nginx/ssl/key.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name example.com;
    return 301 https://$server_name$request_uri;
}
```

### With Let's Encrypt (Certbot)

```bash
# Install Certbot
sudo apt-get install certbot python3-certbot-nginx

# Generate certificate
sudo certbot certonly --nginx -d example.com

# Certificate paths:
# - /etc/letsencrypt/live/example.com/fullchain.pem
# - /etc/letsencrypt/live/example.com/privkey.pem
```

## 📝 Common Configurations

### CORS Headers

```nginx
location /api/ {
    if ($request_method = 'OPTIONS') {
        add_header 'Access-Control-Allow-Origin' '$http_origin';
        add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS';
        add_header 'Access-Control-Allow-Headers' 'Content-Type, Authorization';
        add_header 'Access-Control-Max-Age' 86400;
        return 204;
    }
}
```

Handles CORS requests from frontend.

### URL Rewriting

```nginx
# Rewrite URLs for frontend routing
location / {
    try_files $uri $uri/ /index.html;
}
```

Enables client-side routing in React.

### Rate Limiting

```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;

location /api/ {
    limit_req zone=api_limit burst=20 nodelay;
    proxy_pass http://backend;
}
```

Limits API requests per client.

### Request Timeout

```nginx
location /api/ {
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
}
```

Sets timeout values for proxy connections.

## 🧪 Testing Configuration

### Check Syntax

```bash
nginx -t -c /path/to/nginx.conf
```

### Reload Configuration

```bash
# After modifying nginx.conf
sudo nginx -s reload

# Or using systemd
sudo systemctl reload nginx
```

### Verify Running

```bash
# Check if nginx is running
ps aux | grep nginx

# Check listening ports
netstat -tlnp | grep nginx
lsof -i :80 -i :443
```

## 🔍 Debugging

### Access Logs

Located in: `/var/log/nginx/access.log`

```bash
# Watch real-time logs
tail -f /var/log/nginx/access.log

# Filter by status code
grep " 404 " /var/log/nginx/access.log
```

### Error Logs

Located in: `/var/log/nginx/error.log`

```bash
# View error logs
tail -f /var/log/nginx/error.log

# Filter specific errors
grep "timeout" /var/log/nginx/error.log
```

### Nginx Status

```bash
# View nginx configuration
nginx -V

# Check loaded modules
nginx -V 2>&1 | tr ' ' '\n' | grep -i with
```

## 🚨 Common Issues

### "Connection Refused"

**Problem**: Cannot connect to upstream servers

```
connect() failed (111: Connection refused)
```

**Solution**:

- Verify backend is running
- Check upstream server names and ports
- Verify network connectivity

### "Timeout"

**Problem**: Requests timing out

```
upstream timed out (110: Connection timed out)
```

**Solution**:

- Increase proxy_read_timeout
- Check backend server performance
- Monitor network latency

### "403 Forbidden"

**Problem**: Permission denied

```
Permission denied error
```

**Solution**:

- Check file permissions
- Verify user running nginx
- Check SELinux policies (if enabled)

### "502 Bad Gateway"

**Problem**: Backend unavailable

```
upstream prematurely closed connection
```

**Solution**:

- Restart backend services
- Check backend health
- Review nginx error logs

## 📊 Performance Tuning

### Worker Configuration

```nginx
worker_processes auto;  # Matches CPU cores
worker_connections 4096;  # Connections per worker
```

### Connection Optimization

```nginx
keepalive_timeout 65;
tcp_nopush on;
tcp_nodelay on;
```

### Memory Optimization

```nginx
client_max_body_size 100m;  # Max upload size
proxy_buffer_size 128k;     # Proxy buffer size
```

## 🔄 Container Environment

### Docker Environment Variables

When running with Docker Compose, update services:

```yaml
services:
  nginx:
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - frontend
      - backend
```

### Docker Network

Nginx communicates with services using container names:

- `frontend:3000` - Frontend service
- `backend:5000` - Backend service

## 📋 Monitoring

### Health Check Endpoint

```nginx
location /health {
    access_log off;
    return 200 "healthy\n";
    add_header Content-Type text/plain;
}
```

### Metrics

```nginx
# Enable metrics module (if compiled)
location /nginx_status {
    stub_status on;
    access_log off;
    allow 127.0.0.1;
    deny all;
}
```

## 🚀 Production Deployment

### Checklist

- [ ] Use HTTPS with valid certificates
- [ ] Enable security headers
- [ ] Configure firewall rules
- [ ] Set up monitoring and alerts
- [ ] Enable access and error logging
- [ ] Configure backup and restore
- [ ] Set up log rotation
- [ ] Test failover scenarios
- [ ] Document configuration changes

### Log Rotation

```bash
# Create logrotate configuration
cat > /etc/logrotate.d/nginx <<EOF
/var/log/nginx/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        if [ -f /var/run/nginx.pid ]; then
            kill -USR1 \`cat /var/run/nginx.pid\`
        fi
    endscript
}
EOF
```

## 📚 Resources

- [Nginx Official Documentation](http://nginx.org/en/docs/)
- [Nginx Config Samples](https://github.com/h5bp/server-configs-nginx)
- [Nginx Security Best Practices](https://www.nginx.com/resources/wiki/start/topics/tutorials/config_pitfalls/)

## 📞 Support

For configuration issues:

1. Check nginx error logs: `tail -f /var/log/nginx/error.log`
2. Validate configuration: `nginx -t`
3. Verify upstream services are running
4. Check network connectivity between services

---

**Last Updated**: April 28, 2026
