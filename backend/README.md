# Medical Billing Backend

A robust Node.js and Express-based REST API server for the Medical Billing System. This backend handles all business logic, database operations, authentication, and integration with the frontend application.

## 🚀 Quick Start

### Prerequisites

- Node.js 16+
- npm or yarn
- PostgreSQL 12+
- Redis 6+

### Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Run database migrations
npx prisma migrate dev

# Start the server
npm start
```

Server will run on `http://localhost:5000`

## 📁 Project Structure

```
backend/
├── src/
│   ├── index.js                 # Application entry point
│   ├── config/                  # Configuration files
│   │   ├── db.js               # Database configuration
│   │   └── redis.js            # Redis cache configuration
│   ├── controllers/             # Request handlers
│   │   ├── auth.controller.js
│   │   ├── billing.controller.js
│   │   ├── customer.controller.js
│   │   ├── medicine.controller.js
│   │   ├── inventory.controller.js
│   │   ├── supplier.controller.js
│   │   ├── user.controller.js
│   │   ├── batch.controller.js
│   │   ├── category.controller.js
│   │   └── manufacturer.controller.js
│   ├── routes/                  # API route definitions
│   │   ├── auth.routes.js
│   │   ├── billing.routes.js
│   │   ├── inventory.routes.js
│   │   └── user.routes.js
│   ├── middlewares/             # Custom middleware
│   │   ├── auth.middleware.js   # JWT verification
│   │   ├── error.middleware.js  # Error handling
│   │   └── validate.middleware.js # Input validation
│   ├── validators/              # Request validators
│   │   ├── billing.validator.js
│   │   └── inventory.validator.js
│   └── utils/                   # Utility functions
│       ├── jwt.utils.js         # JWT token generation
│       ├── invoice.utils.js     # Invoice generation
│       └── seed.js              # Database seeding
├── prisma/
│   ├── schema.prisma            # Database schema
│   └── migrations/              # Database migrations
├── .env.example                 # Environment variables template
├── package.json
├── docker-compose.yml           # Docker configuration
└── Dockerfile.dev               # Development Docker image
```

## 🔧 Environment Configuration

Create a `.env` file in the backend directory:

```env
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/medical_billing"

# Redis
REDIS_URL="redis://localhost:6379"

# JWT
JWT_SECRET="your-super-secret-jwt-key-change-in-production"
JWT_EXPIRE="7d"

# Server
PORT=5000
NODE_ENV=development

# Frontend
FRONTEND_URL="http://localhost:3000"

# Email (Optional)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
```

## 📚 API Endpoints

### Authentication (`/api/auth`)

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout
- `POST /api/auth/refresh` - Refresh token
- `POST /api/auth/forgot-password` - Request password reset
- `POST /api/auth/reset-password` - Reset password

### Users (`/api/users`)

- `GET /api/users` - Get all users (admin only)
- `GET /api/users/:id` - Get user details
- `PUT /api/users/:id` - Update user profile
- `DELETE /api/users/:id` - Delete user (admin only)
- `PUT /api/users/:id/password` - Change password
- `PUT /api/users/:id/role` - Update user role (admin only)

### Customers (`/api/customers`)

- `GET /api/customers` - Get all customers
- `POST /api/customers` - Create new customer
- `GET /api/customers/:id` - Get customer details
- `PUT /api/customers/:id` - Update customer
- `DELETE /api/customers/:id` - Delete customer

### Medicines (`/api/medicines`)

- `GET /api/medicines` - Get all medicines
- `POST /api/medicines` - Add new medicine
- `GET /api/medicines/:id` - Get medicine details
- `PUT /api/medicines/:id` - Update medicine
- `DELETE /api/medicines/:id` - Delete medicine
- `GET /api/medicines/category/:categoryId` - Get medicines by category

### Billing (`/api/billing`)

- `GET /api/billing` - Get all bills
- `POST /api/billing` - Create new bill
- `GET /api/billing/:id` - Get bill details
- `PUT /api/billing/:id` - Update bill
- `DELETE /api/billing/:id` - Delete bill
- `GET /api/billing/:id/invoice` - Download invoice

### Inventory (`/api/inventory`)

- `GET /api/inventory` - Get inventory status
- `POST /api/inventory/add` - Add stock
- `POST /api/inventory/remove` - Remove stock
- `GET /api/inventory/low-stock` - Get low stock items
- `PUT /api/inventory/:id` - Update inventory

### Suppliers (`/api/suppliers`)

- `GET /api/suppliers` - Get all suppliers
- `POST /api/suppliers` - Add supplier
- `GET /api/suppliers/:id` - Get supplier details
- `PUT /api/suppliers/:id` - Update supplier
- `DELETE /api/suppliers/:id` - Delete supplier

### Reports (`/api/reports`)

- `GET /api/reports/sales` - Sales report
- `GET /api/reports/inventory` - Inventory report
- `GET /api/reports/billing` - Billing report
- `GET /api/reports/top-medicines` - Top selling medicines

## 🔐 Authentication

The API uses JWT (JSON Web Tokens) for authentication:

1. User logs in with credentials
2. Backend generates JWT token
3. Token is stored in HTTP-only cookie (secure)
4. Token is validated on protected routes using `authMiddleware`
5. Token expires after specified duration

### Protected Routes

Routes requiring authentication are protected by the `authMiddleware`:

```javascript
router.get("/profile", authMiddleware, getUserProfile);
```

## 💾 Database Schema

### Key Tables

**users**

- id, email, password, firstName, lastName, role, createdAt, updatedAt

**customers**

- id, name, phone, email, address, city, state, pincode, createdAt, updatedAt

**medicines**

- id, name, genericName, manufacturerId, categoryId, price, dosage, stock, createdAt, updatedAt

**billing**

- id, customerId, totalAmount, status, createdAt, updatedAt

**inventory**

- id, medicineId, quantity, batchNumber, expiryDate, createdAt, updatedAt

**suppliers**

- id, name, contactPerson, phone, email, address, createdAt, updatedAt

See [Prisma Schema](./prisma/schema.prisma) for complete schema.

## 🗄️ Database Migrations

### Create Migration

```bash
npx prisma migrate dev --name description_of_change
```

### Deploy Migration

```bash
npx prisma migrate deploy
```

### Reset Database (Development Only)

```bash
npx prisma migrate reset
```

### Seed Database

```bash
npm run seed
```

## 🐳 Docker Setup

### Build Image

```bash
docker build -f Dockerfile.dev -t medical-billing-backend .
```

### Run Container

```bash
docker run -p 5000:5000 --env-file .env medical-billing-backend
```

### Using Docker Compose

```bash
docker-compose up -d backend
```

## 📊 Performance Features

- **Redis Caching**: Frequently accessed data is cached
- **Pagination**: Large datasets are paginated
- **Indexing**: Database indexes on frequently queried fields
- **Connection Pooling**: Efficient database connections

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

## 🛠️ Development

### Start Development Server with Hot Reload

```bash
npm run dev
```

### Lint Code

```bash
npm run lint
```

### Format Code

```bash
npm run format
```

## 📝 Validation

Input validation is performed using custom validators:

- `billing.validator.js` - Billing-related validations
- `inventory.validator.js` - Inventory-related validations

Validation middleware ensures all inputs meet requirements before processing.

## 🚨 Error Handling

The backend implements centralized error handling:

- All errors are caught by `errorMiddleware`
- Errors are logged with proper context
- User-friendly error messages are returned
- HTTP status codes are properly set

### Error Response Format

```json
{
  "success": false,
  "error": "Error message",
  "statusCode": 400
}
```

## 📈 Logging

Logs are structured and include:

- Timestamp
- Log level (info, warn, error)
- Request ID for tracing
- User information (where applicable)
- Error stack traces

## 🔄 API Response Format

All successful responses follow this format:

```json
{
  "success": true,
  "data": {},
  "message": "Operation successful",
  "statusCode": 200
}
```

## 🚀 Deployment

### Production Checklist

- [ ] Set `NODE_ENV=production`
- [ ] Use strong `JWT_SECRET`
- [ ] Configure database with backups
- [ ] Set up Redis for caching
- [ ] Enable CORS for frontend domain
- [ ] Use HTTPS/SSL
- [ ] Configure environment variables securely
- [ ] Set up monitoring and logging
- [ ] Configure database connection pooling

## 🔗 Integration with Frontend

The frontend communicates with this backend API:

- Base URL: `http://localhost:5000` (development)
- All requests include JWT token in Authorization header
- CORS is configured to allow frontend origin

## 📞 Support & Troubleshooting

### Common Issues

**Database Connection Error**

```bash
# Check PostgreSQL is running
sudo service postgresql status

# Verify DATABASE_URL
echo $DATABASE_URL
```

**Redis Connection Error**

```bash
# Check Redis is running
redis-cli ping
```

**Port Already in Use**

```bash
# Find process using port 5000
lsof -i :5000

# Kill the process
kill -9 <PID>
```

**Migration Issues**

```bash
# Reset and reseed (development only)
npx prisma migrate reset
```

## 📚 Dependencies

- **express** - Web framework
- **prisma** - ORM
- **redis** - Caching
- **jsonwebtoken** - JWT authentication
- **bcryptjs** - Password hashing
- **dotenv** - Environment variables
- **cors** - Cross-Origin Resource Sharing
- **express-validator** - Input validation

## 🔐 Security Best Practices

- Passwords are hashed with bcryptjs
- JWT tokens include expiration
- Input validation on all endpoints
- SQL injection prevention via Prisma ORM
- CORS configured for specific origins
- Rate limiting recommended for production
- Environment variables for sensitive data

## 📜 License

Proprietary - Medical Billing System

---

**Last Updated**: April 28, 2026
