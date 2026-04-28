# Medical Billing Frontend

A modern, responsive React and TypeScript-based user interface for the Medical Billing System. Built with Vite for fast development and optimized production builds.

## 🚀 Quick Start

### Prerequisites

- Node.js 16+
- npm or yarn
- Backend API running (see backend README)

### Installation

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

Application will run on `http://localhost:5173`

## 📁 Project Structure

```
frontend/
├── src/
│   ├── main.tsx                 # Application entry point
│   ├── App.tsx                  # Root component
│   ├── App.css                  # Global styles
│   ├── index.css                # Base styles
│   ├── api/                     # API client setup
│   ├── assets/                  # Images and static assets
│   ├── components/
│   │   ├── ProtectedRoute.tsx   # Route protection wrapper
│   │   ├── layout/              # Layout components
│   │   │   ├── Layout.tsx       # Main layout wrapper
│   │   │   ├── Sidebar.tsx      # Navigation sidebar
│   │   │   └── Topbar.tsx       # Top navigation bar
│   │   └── ui/                  # Reusable UI components
│   │       ├── button.tsx
│   │       ├── input.tsx
│   │       ├── card.tsx
│   │       ├── select.tsx
│   │       ├── dialog.tsx
│   │       ├── dropdown-menu.tsx
│   │       ├── table.tsx
│   │       ├── tabs.tsx
│   │       ├── badge.tsx
│   │       ├── alert.tsx
│   │       ├── avatar.tsx
│   │       ├── separator.tsx
│   │       ├── sheet.tsx
│   │       ├── skeleton.tsx
│   │       ├── label.tsx
│   │       └── sonner.tsx       # Toast notifications
│   ├── context/                 # React context providers
│   ├── hooks/                   # Custom React hooks
│   │   └── useNotifications.ts
│   ├── lib/
│   │   ├── api.ts               # API client configuration
│   │   └── utils.ts             # Utility functions
│   ├── pages/                   # Page components
│   │   ├── Dashboard.tsx        # Dashboard
│   │   ├── Login.tsx            # Login page
│   │   ├── Billing.tsx          # Billing management
│   │   ├── Customers.tsx        # Customer list
│   │   ├── Inventory.tsx        # Inventory management
│   │   ├── Suppliers.tsx        # Supplier management
│   │   ├── Reports.tsx          # Analytics and reports
│   │   ├── Settings.tsx         # User settings
│   │   └── **/                  # Sub-pages for each section
│   ├── store/                   # Zustand state management
│   │   ├── auth.store.ts        # Authentication state
│   │   └── notification.store.ts # Notification state
│   ├── types/                   # TypeScript types and interfaces
│   │   └── index.ts
│   └── utils/                   # Utility functions
├── @/components/                # Alias for components
│   └── ui/                      # Shadcn/ui components
├── public/                      # Static assets
│   ├── favicon.svg
│   └── icons.svg
├── index.html                   # HTML entry point
├── vite.config.ts               # Vite configuration
├── tsconfig.json                # TypeScript configuration
├── tsconfig.app.json            # App-specific TS config
├── tsconfig.node.json           # Node-specific TS config
├── eslint.config.js             # ESLint configuration
├── components.json              # Shadcn/ui config
├── nginx.conf                   # Nginx configuration
├── Dockerfile.dev               # Development Docker image
├── .dockerignore
├── .gitignore
└── package.json
```

## 🔧 Environment Configuration

Create a `.env` file in the frontend directory:

```env
# API Configuration
VITE_API_BASE_URL=http://localhost:5000

# App Configuration
VITE_APP_NAME=Medical Billing System
VITE_APP_VERSION=1.0.0

# Features
VITE_ENABLE_ANALYTICS=true
VITE_ENABLE_SENTRY=false
```

## 📚 Available Pages

### Public Pages

- **Login** (`/login`) - User authentication

### Protected Pages (Requires Authentication)

- **Dashboard** (`/`) - Overview and statistics
- **Billing** (`/billing`) - Invoice management and creation
- **Customers** (`/customers`) - Customer management
- **Inventory** (`/inventory`) - Medicine and stock management
- **Suppliers** (`/suppliers`) - Supplier information
- **Reports** (`/reports`) - Analytics and statistics
- **Settings** (`/settings`) - User preferences

## 🎨 UI Components

The application uses a comprehensive set of reusable UI components:

### Layout Components

- `Layout` - Main application layout
- `Sidebar` - Navigation sidebar
- `Topbar` - Top navigation bar

### Form Components

- `Button` - Clickable button
- `Input` - Text input field
- `Select` - Dropdown selection
- `Label` - Form labels
- `Dialog` - Modal dialogs
- `Sheet` - Side sheet panels

### Data Display

- `Table` - Data tables with sorting/pagination
- `Card` - Content cards
- `Badge` - Status badges
- `Avatar` - User avatars
- `Skeleton` - Loading skeletons

### Navigation

- `Tabs` - Tab navigation
- `DropdownMenu` - Dropdown menus
- `Separator` - Visual separator

### Feedback

- `Alert` - Alert messages
- `Sonner` - Toast notifications

## 🔐 Authentication

The application implements JWT-based authentication:

1. User submits login credentials
2. Backend validates and returns JWT token
3. Token is stored securely (HTTP-only cookie)
4. Token is automatically included in API requests
5. Protected routes verify token before rendering

### Protected Routes

Protected routes are wrapped with `ProtectedRoute` component:

```tsx
<ProtectedRoute>
  <Dashboard />
</ProtectedRoute>
```

## 🏪 State Management

Uses **Zustand** for state management:

### Auth Store (`src/store/auth.store.ts`)

- User authentication state
- Login/logout actions
- Token management
- User profile

### Notification Store (`src/store/notification.store.ts`)

- Toast notifications
- Error alerts
- Success messages

## 🎣 Custom Hooks

### useNotifications

```tsx
import { useNotifications } from "@/hooks/useNotifications";

const { notify } = useNotifications();
notify("success", "Operation successful");
```

## 📡 API Integration

### Base Configuration

The API client is configured in `src/lib/api.ts`:

```tsx
import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  withCredentials: true, // Include cookies
});
```

### Making API Calls

```tsx
import { api } from "@/lib/api";

// GET request
const data = await api.get("/api/customers");

// POST request
const response = await api.post("/api/billing", billData);

// PUT request
await api.put(`/api/customers/${id}`, updatedData);

// DELETE request
await api.delete(`/api/suppliers/${id}`);
```

## 🎯 Key Features

### Dashboard

- Overview statistics
- Recent transactions
- Quick actions

### Billing Management

- Create invoices
- View billing history
- Download invoices
- Payment tracking

### Customer Management

- Add/edit customers
- View customer details
- Customer history
- Contact information

### Inventory Management

- Track medicine stock
- Low stock alerts
- Add/remove items
- Batch tracking
- Expiry date management

### Supplier Management

- Supplier directory
- Contact information
- Order history
- Performance metrics

### Reports

- Sales reports
- Inventory reports
- Revenue analysis
- Top selling medicines

### Settings

- User profile management
- Password change
- Preferences
- Theme selection

## 🎨 Styling

The application uses:

- **Tailwind CSS** - Utility-first CSS framework
- **CSS Modules** - Component-scoped styles
- **Responsive Design** - Mobile-first approach

### Theme Colors

- Primary: Blue
- Success: Green
- Warning: Orange
- Error: Red
- Background: Light gray

## 🚀 Development

### Start Development Server

```bash
npm run dev
```

### Build for Production

```bash
npm run build
```

### Preview Production Build

```bash
npm run preview
```

### Lint Code

```bash
npm run lint
```

### Type Check

```bash
npm run type-check
```

## 🧪 Testing

### Run Tests

```bash
npm test
```

### Run Tests with Coverage

```bash
npm run test:coverage
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

## 🐳 Docker Setup

### Build Image

```bash
docker build -f Dockerfile.dev -t medical-billing-frontend .
```

### Run Container

```bash
docker run -p 3000:3000 medical-billing-frontend
```

### Using Docker Compose

```bash
docker-compose up -d frontend
```

## 📦 Build Optimization

The production build includes:

- Code splitting
- Lazy loading of routes
- Asset minification
- CSS purging
- Image optimization

### Build Output

```bash
npm run build
# Output in dist/ directory
# Ready for deployment
```

## 🔗 API Integration Points

### Authentication

- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration
- `POST /api/auth/logout` - User logout

### Main Operations

- `GET /api/dashboard` - Dashboard data
- `GET /api/customers` - Fetch customers
- `POST /api/billing` - Create invoice
- `GET /api/inventory` - Get inventory
- `GET /api/reports/sales` - Sales report

## 📱 Responsive Design

The application is fully responsive:

- Mobile: 320px and up
- Tablet: 768px and up
- Desktop: 1024px and up

All components adapt to screen size and touch interactions.

## ♿ Accessibility

Features include:

- ARIA labels on interactive elements
- Keyboard navigation support
- Color contrast compliance
- Focus management
- Screen reader support

## 🔍 SEO Optimization

- Meta tags for page titles
- Descriptive meta descriptions
- Semantic HTML
- Performance optimization

## 🐛 Troubleshooting

### Development Server Won't Start

```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
npm run dev
```

### Build Issues

```bash
# Clear Vite cache
rm -rf dist .vite
npm run build
```

### API Connection Issues

- Verify backend is running on correct port
- Check `VITE_API_BASE_URL` in .env
- Check browser console for CORS errors

### Port Already in Use

```bash
# Change port in vite.config.ts or use
npm run dev -- --port 3001
```

## 📚 Dependencies

### Core

- **react** - UI library
- **react-dom** - React DOM rendering
- **react-router-dom** - Routing

### State & API

- **zustand** - State management
- **axios** - HTTP client

### UI & Styling

- **tailwindcss** - CSS framework
- **shadcn/ui** - Component library

### Development

- **vite** - Build tool
- **typescript** - Type safety
- **eslint** - Code linting

## 🚀 Performance Tips

1. Use React DevTools Profiler
2. Monitor network requests
3. Optimize images
4. Lazy load routes and components
5. Use memoization for expensive renders
6. Cache API responses with Redux/Zustand

## 📜 License

Proprietary - Medical Billing System

---

**Last Updated**: April 28, 2026
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
globalIgnores(['dist']),
{
files: ['**/*.{ts,tsx}'],
extends: [
// Other configs...
// Enable lint rules for React
reactX.configs['recommended-typescript'],
// Enable lint rules for React DOM
reactDom.configs.recommended,
],
languageOptions: {
parserOptions: {
project: ['./tsconfig.node.json', './tsconfig.app.json'],
tsconfigRootDir: import.meta.dirname,
},
// other options...
},
},
])

```

```
