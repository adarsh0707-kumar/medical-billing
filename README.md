# Medical Billing System

A comprehensive full-stack medical billing application built with Node.js, Express, Prisma, React, and TypeScript. This system is designed to manage billing operations, inventory, customers, and reporting for medical facilities.

## 🏗️ Project Structure

The project consists of three main components:

```
medical-billing/
├── frontend/          # React + TypeScript UI application
├── backend/           # Node.js + Express API server
├── nginx/             # Web server configuration
├── docker-compose.yml # Container orchestration
└── Architecture.txt   # System architecture documentation
```

## 🚀 Quick Start

### Prerequisites

- Docker & Docker Compose (recommended)
- Node.js 16+ (for local development)
- npm or yarn package manager
- PostgreSQL (if running without Docker)
- Redis (for caching)

### Using Docker Compose (Recommended)

```bash
# Start all services
docker-compose up -d

# Stop all services
docker-compose down

# View logs
docker-compose logs -f
```

The application will be available at:

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:5000
- **Nginx**: http://localhost:80

### Local Development Setup

#### Backend Setup

```bash
cd backend
npm install
npx prisma migrate dev
npm start
```

Server runs on `http://localhost:5000`

#### Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Application runs on `http://localhost:5173`

## 📋 Features

### Frontend

- **Modern UI**: Built with React and TypeScript
- **Responsive Design**: Works on desktop, tablet, and mobile
- **Components**: Pre-built UI components for common elements
- **State Management**: Centralized store for authentication and notifications
- **API Integration**: Seamless integration with backend services

### Backend

- **RESTful API**: Complete API for all operations
- **Authentication**: JWT-based user authentication
- **Database**: Prisma ORM with PostgreSQL
- **Caching**: Redis for improved performance
- **Validation**: Input validation and error handling
- **Modules**:
  - Authentication
  - Billing Management
  - Customer Management
  - Inventory Management
  - Medicine Catalog
  - Supplier Management
  - User Management
  - Reports & Analytics

### Nginx

- **Reverse Proxy**: Routes requests to appropriate services
- **Load Balancing**: Handles multiple backend instances
- **Static File Serving**: Serves frontend assets efficiently
- **SSL/TLS**: Ready for HTTPS configuration

## 📁 Detailed Component Documentation

For detailed information about each component, refer to:

- **[Frontend Documentation](./frontend/README.md)** - UI setup, components, and usage
- **[Backend Documentation](./backend/README.md)** - API endpoints, database schema, and configuration
- **[Nginx Documentation](./nginx/README.md)** - Web server setup and configuration

## 🔧 Configuration

### Environment Variables

Create a `.env` file in the `backend` directory:

```env
DATABASE_URL="postgresql://user:password@localhost:5432/medical_billing"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="your-secret-key"
PORT=5000
NODE_ENV=development
```

Create a `.env` file in the `frontend` directory:

```env
VITE_API_BASE_URL="http://localhost:5000"
```

## 📦 Tech Stack

| Layer            | Technology                               |
| ---------------- | ---------------------------------------- |
| Frontend         | React 18, TypeScript, Vite, Tailwind CSS |
| Backend          | Node.js, Express, Prisma, PostgreSQL     |
| Caching          | Redis                                    |
| Containerization | Docker, Docker Compose                   |
| Web Server       | Nginx                                    |

## 🗄️ Database Schema

Key entities:

- Users (Authentication & Authorization)
- Customers (Client Management)
- Medicines (Product Catalog)
- Suppliers (Vendor Management)
- Batches (Medicine Batches)
- Billing (Invoice Management)
- Categories (Classification)
- Manufacturers (Medicine Producers)

See [Prisma Schema](./backend/prisma/schema.prisma) for detailed database structure.

## 🔐 Security

- JWT authentication for API endpoints
- Password hashing and validation
- Input sanitization and validation
- CORS configuration
- Protected routes on frontend
- Environment variable management

## 📊 API Documentation

The backend provides RESTful APIs for all operations:

### Main Routes

- `/api/auth` - Authentication endpoints
- `/api/users` - User management
- `/api/customers` - Customer operations
- `/api/medicines` - Medicine catalog
- `/api/billing` - Billing operations
- `/api/inventory` - Inventory management
- `/api/suppliers` - Supplier management
- `/api/reports` - Analytics and reports

## 🧪 Testing

### Backend Testing

```bash
cd backend
npm test
```

### Frontend Testing

```bash
cd frontend
npm test
```

## 📈 Performance Optimization

- Redis caching for frequently accessed data
- Database query optimization with Prisma
- Frontend code splitting and lazy loading
- Image optimization and compression
- Nginx gzip compression

## 🚨 Error Handling

- Centralized error middleware in backend
- User-friendly error messages
- Detailed logging for debugging
- Graceful error recovery

## 📝 API Response Format

All API responses follow a standard format:

```json
{
  "success": true,
  "data": {},
  "message": "Operation successful"
}
```

Error responses:

```json
{
  "success": false,
  "error": "Error message",
  "statusCode": 400
}
```

## 🐛 Troubleshooting

### Database Connection Issues

- Ensure PostgreSQL is running
- Check DATABASE_URL in .env
- Run migrations: `npx prisma migrate dev`

### Redis Connection Issues

- Ensure Redis server is running
- Check REDIS_URL configuration
- Verify Redis is accessible on the configured port

### Frontend Build Issues

- Clear node_modules: `rm -rf node_modules && npm install`
- Clear Vite cache: `rm -rf dist && npm run build`

### Port Already in Use

- Change ports in docker-compose.yml or environment variables
- Kill process using the port: `lsof -ti:PORT | xargs kill -9`

## 📚 Additional Resources

- [Project Architecture](./Architecture.txt)
- [Docker Documentation](https://docs.docker.com/)
- [React Documentation](https://react.dev)
- [Express Documentation](https://expressjs.com)
- [Prisma Documentation](https://www.prisma.io/docs)

## 👥 Contributing

1. Create a feature branch
2. Make your changes
3. Test thoroughly
4. Submit a pull request

## 📄 License

This project is proprietary and intended for medical billing management.

## 📞 Support

For issues or questions, please contact the development team or refer to the detailed component documentation.

---

**Last Updated**: April 28, 2026
