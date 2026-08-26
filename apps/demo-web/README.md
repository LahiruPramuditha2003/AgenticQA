# TechStore Demo Application

A professional e-commerce platform built for testing the AgenticQA VSCode extension. This application features a complete online store with product browsing, shopping cart, checkout flow, user authentication, and admin dashboard.

## Features

### Customer-Facing Features
- **Home Page**: Hero banner, featured products, new arrivals, categories, and promotional sections
- **Product Listing**: Advanced filtering (category, brand, price, rating), sorting, and pagination
- **Product Detail**: Image gallery, specifications, reviews, related products
- **Shopping Cart**: Add/remove items, quantity controls, order summary
- **Checkout**: Multi-step checkout (shipping → payment → review → confirmation)
- **User Authentication**: Login, register, password management
- **Account Dashboard**: Order history, profile management, preferences

### Admin Features
- **Dashboard Overview**: Sales statistics, recent orders, top products
- **Product Management**: View, add, edit, delete products
- **Order Management**: Track and manage customer orders
- **Customer Management**: View customer data and order history
- **Analytics**: Sales trends and performance metrics
- **Settings**: Store configuration

## Test Scenarios for AgenticQA

### Basic Navigation Tests
```
- Navigate to the home page
- Click on a product category
- Search for a product by name
- Navigate to the cart page
```

### Product Interaction Tests
```
- Filter products by category "Laptops"
- Sort products by price from low to high
- Filter products with rating 4 stars and up
- Click on a product to view details
- View product specifications tab
- Read customer reviews
```

### Shopping Cart Tests
```
- Add a product to the cart
- Increase product quantity in cart
- Remove a product from the cart
- Verify cart total calculation
- Navigate to checkout from cart
```

### Checkout Flow Tests
```
- Fill in shipping address form
- Select payment method
- Review order before placing
- Place an order successfully
- Verify order confirmation page
```

### Authentication Tests
```
- Login with customer account
- Register a new user account
- Update user profile information
- Change password
- Logout from account
```

### Complex Multi-Step Tests
```
- Login as customer
- Search for "MacBook Pro"
- Add product to cart
- Proceed to checkout
- Fill shipping information
- Complete purchase
- Verify order in account orders page
```

### Admin Tests
```
- Login as admin
- View dashboard statistics
- Navigate to products page
- View orders management
- Check customer list
```

### Self-Healing Test Scenarios

The application includes intentional variations to test AgenticQA's self-healing capabilities:

1. **Button Text Variations**: Some buttons may have slightly different text
2. **Dynamic Content**: Product availability and prices change
3. **Multiple Identifiers**: Elements have multiple possible selectors (id, data-testid, aria-label)

## Demo Accounts

### Customer Account
- **Email**: customer@example.com
- **Password**: password123

### Admin Account
- **Email**: admin@techstore.com
- **Password**: admin123

## Running the Application

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

The application will be available at: http://localhost:5173

## Technology Stack

- **Frontend**: React 19 with TypeScript
- **Routing**: React Router v7
- **Styling**: Custom CSS with CSS Variables
- **State Management**: React Context API
- **Mock API**: LocalStorage-based mock API service

## Project Structure

```
src/
├── components/          # Reusable UI components
│   ├── Button.tsx
│   ├── Input.tsx
│   ├── Card.tsx
│   ├── Modal.tsx
│   ├── Rating.tsx
│   └── Navbar.tsx
├── contexts/            # React Context providers
│   ├── CartContext.tsx
│   ├── AuthContext.tsx
│   └── ToastContext.tsx
├── pages/               # Page components
│   ├── Home.tsx
│   ├── products/
│   │   ├── Products.tsx
│   │   └── ProductDetail.tsx
│   ├── checkout/
│   │   ├── Cart.tsx
│   │   └── Checkout.tsx
│   ├── auth/
│   │   ├── Login.tsx
│   │   └── Register.tsx
│   ├── user/
│   │   ├── Account.tsx
│   │   ├── Orders.tsx
│   │   └── Profile.tsx
│   └── admin/
│       └── Admin.tsx
├── services/            # API and mock data
│   ├── api.ts
│   └── mockData.ts
├── types/               # TypeScript type definitions
│   └── index.ts
└── utils/               # Utility functions
```

## AgenticQA Configuration

The `.agenticqa.json` file is configured with:

```json
{
  "baseUrl": "http://localhost:5173",
  "testDir": "tests/generated",
  "allowlistedDomains": ["context7.com"],
  "webServer": {
    "command": "npm run dev -- --port 5173",
    "cwd": ".",
    "timeoutMs": 60000,
    "reuseExistingServer": true
  }
}
```

## Testing Tips

1. **Start Simple**: Begin with basic navigation tests before complex flows
2. **Use Natural Language**: Describe tests in plain English
3. **Be Specific**: Include specific product names, prices, and actions
4. **Test Self-Healing**: Modify element attributes to test healing capabilities
5. **Verify Data**: Check that orders, cart items, and user data persist correctly

## Sample Test Requests for AgenticQA

1. "Navigate to home page and click on the Laptops category"
2. "Search for iPhone and add the first result to cart"
3. "Login with customer@example.com and password123"
4. "Go to cart and increase the quantity of the first item to 2"
5. "Proceed to checkout and fill in shipping address"
6. "Select credit card payment and place the order"
7. "Navigate to my account and view order history"
8. "Filter products by brand Apple and sort by price high to low"
9. "Open the MacBook Pro product page and read the specifications"
10. "Write a 5-star review for a product I purchased"
