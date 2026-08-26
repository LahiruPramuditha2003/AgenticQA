# AgenticQA Test Templates

This document provides ready-to-use test templates for common e-commerce and web application scenarios. Copy and paste these prompts into AgenticQA's "New Request" command.

## Table of Contents

1. [Browsing & Product Discovery](#browsing--product-discovery)
2. [Shopping Cart Operations](#shopping-cart-operations)
3. [Checkout Flow](#checkout-flow)
4. [User Authentication](#user-authentication)
5. [User Account Management](#user-account-management)
6. [Admin Dashboard](#admin-dashboard)
7. [Complex Multi-Step Scenarios](#complex-multi-step-scenarios)
8. [Edge Cases & Error Handling](#edge-cases--error-handling)
9. [UI/UX Verification](#uiux-verification)

---

## Browsing & Product Discovery

### 1. Home Page Navigation
```
Navigate to the home page and verify the hero section displays correctly. Check that the main heading is visible and the navigation bar contains links to Products, Cart, and Login pages.
```

### 2. Product Search
```
Search for "laptop" in the navbar search box and verify the results page shows relevant products. Then search for "wireless" and confirm multiple product categories appear (headphones, mouse, keyboard).
```

### 3. Product Filtering & Sorting
```
Go to the Products page, filter by category "Smartphones", sort by price low to high, and verify the first product is the most affordable. Then add a price filter max $1000 and confirm only affordable phones show.
```

### 4. Product Detail Page
```
Open a product detail page (e.g., Sony WH-1000XM5 headphones). Verify the price, rating stars, and "Add to Cart" button are visible. Check that product description text is present.
```

### 5. Category Navigation
```
From home page, click on each category card (Laptops, Smartphones, Audio, etc.) and verify the filtered products page loads with the correct category heading and product grid.
```

---

## Shopping Cart Operations

### 6. Add to Cart from Product Detail
```
Navigate to a product page (e.g., MacBook Air M2), click "Add to Cart", and verify a success toast appears. Then check the cart icon in navbar shows "1" item indicator.
```

### 7. Cart Quantity Management
```
Go to the cart page, find a product in the cart, increase quantity to 3, and verify the subtotal updates correctly. Then decrease to 1 and confirm it returns to original price.
```

### 8. Remove from Cart
```
Add a product to cart, go to cart page, click remove on that item, and verify it disappears from the cart with a confirmation toast message.
```

### 9. Empty Cart Checkout Redirect
```
Navigate directly to /checkout with an empty cart and verify the user is redirected back to cart page with a warning message.
```

### 10. Update Cart with Multiple Items
```
Add 3 different products to cart, go to cart page, verify all 3 items are listed with correct prices, then update quantity of one item to 2 and confirm total updates.
```

---

## Checkout Flow

### 11. Complete Checkout - Step 1
```
Add a product to cart, go to checkout, fill in shipping form with name "John Doe", address "123 Main St", city "New York", ZIP "10001", and click Continue. Verify payment step appears.
```

### 12. Complete Checkout - All Steps
```
Add AirPods Pro to cart, complete checkout with shipping info (Jane Smith, 456 Oak Ave, Los Angeles, CA 90001), select Credit Card payment, enter card details, place order, and verify order confirmation page shows with order number.
```

### 13. Checkout Form Validation
```
On checkout shipping step, try to proceed without filling any fields. Verify error messages appear for required fields: name, address, city, ZIP, and email.
```

### 14. Checkout - Guest vs Logged In
```
Add item to cart as guest, proceed to checkout, verify guest checkout form appears. Then cancel, login with valid credentials, return to checkout, and verify saved address appears.
```

---

## User Authentication

### 15. Login with Valid Credentials
```
Go to login page, enter customer@example.com and password123, click Sign In, and verify user is redirected to account page with welcome message.
```

### 16. Login with Invalid Credentials
```
Attempt login with wrong@email.com and wrongpass, click Sign In, and verify an error toast shows "Invalid credentials" or similar error message.
```

### 17. User Registration
```
Go to register page, fill in name "Test User", email "testuser@example.com", password "SecurePass123!", and confirm password. Click Register and verify account is created with success message.
```

### 18. Registration Validation
```
Try registering with mismatched passwords (password: "test123", confirm: "test456") and verify error message shows passwords must match.
```

### 19. Logout Flow
```
Login as a user, click user menu in navbar, select Logout, and verify user icon changes back to default logged-out state and navbar shows Login link.
```

### 20. Password Reset Request
```
Go to login page, click "Forgot Password?", enter registered email, submit form, and verify confirmation message appears with instructions.
```

---

## User Account Management

### 21. View Order History
```
Login as customer@example.com, go to Account page, click Orders in sidebar, and verify order history table shows previous orders with order numbers, dates, and statuses.
```

### 22. Update Profile Information
```
Login, go to Profile settings, change phone number to "555-123-4567", click Save Changes, and verify success toast shows "Profile updated successfully".
```

### 23. Account Navigation
```
From account dashboard, verify sidebar navigation shows all sections: Overview, Orders, Profile, Settings. Click each and confirm page content changes accordingly.
```

### 24. Change Password
```
Login, go to Settings, change password from old to new, confirm new password, save changes, logout, then login with new password to verify it works.
```

---

## Admin Dashboard

### 25. Admin Login & Dashboard Access
```
Login with admin@techstore.com and admin123, navigate to /admin, and verify admin dashboard loads with tabs for Products, Orders, and Analytics.
```

### 26. Admin Product Management
```
In admin panel Products tab, verify table shows all products with columns: ID, Name, Category, Price, Stock, Actions. Check that Edit and Delete buttons appear for each product.
```

### 27. Admin Order Management
```
Go to admin Orders tab, verify orders table displays columns: Order ID, Customer, Total, Status, Date. Check status badges show different states (Processing, Shipped, Delivered).
```

### 28. Admin - Add New Product
```
As admin, go to Products tab, click "Add Product", fill in name "Test Product", category "Electronics", price 99.99, stock 50, save, and verify product appears in table.
```

---

## Complex Multi-Step Scenarios

### 29. Full Shopping Journey
```
Search for "gaming", add a gaming laptop to cart, go to cart, update quantity to 2, proceed to checkout, login with customer@example.com, fill shipping and payment, complete order, and verify confirmation page.
```

### 30. Browse → Filter → Compare → Purchase
```
Navigate to Products, filter by Laptops category, sort by rating, open top-rated laptop detail page, read reviews, add to cart, checkout as guest with email "guest@test.com", and complete purchase.
```

### 31. Cart Persistence After Login
```
As guest, add a product to cart, go to login page, login with customer@example.com, and verify cart still contains the product after authentication.
```

### 32. Category Navigation Flow
```
From home page, click "Smartphones" category card, verify filtered products page loads, click first product, add to cart, then navigate to "Laptops" category, and confirm URL and products update correctly.
```

### 33. Wishlist Operations (if available)
```
Login, browse products, add 3 items to wishlist, go to wishlist page, verify all 3 items appear, move one to cart, and verify wishlist updates.
```

---

## Edge Cases & Error Handling

### 34. Out of Stock Product
```
Find a product with stock 0 (or set one to 0), verify "Out of Stock" badge shows and "Add to Cart" button is disabled or shows "Out of Stock" text.
```

### 35. Invalid Route Handling
```
Navigate to /nonexistent-page and verify either 404 page shows or user is redirected to home page.
```

### 36. Search with No Results
```
Search for "xyz123nonexistent" and verify "No products found" message displays on results page.
```

### 37. Negative Quantity Prevention
```
Add item to cart, go to cart page, try to decrease quantity below 1, and verify quantity stays at minimum 1 or remove option appears instead.
```

### 38. Session Timeout
```
Login, wait for session to expire (or manually clear cookies), try to access account page, and verify redirect to login with appropriate message.
```

### 39. Double Submit Prevention
```
During checkout, click "Place Order" button multiple times rapidly, and verify only one order is created (check order confirmation appears once).
```

---

## UI/UX Verification

### 40. Responsive Navbar
```
On home page, verify navbar shows all links (Home, Products, Login) on desktop. Resize to mobile width and confirm hamburger menu appears with same navigation options.
```

### 41. Toast Notification System
```
Add 3 different products to cart from different pages, and verify each triggers a toast notification with product name and "Added to cart" message that auto-dismisses.
```

### 42. Modal Dialog Functionality
```
On products page, click quick view on any product card, verify modal opens with product details, and clicking X button or outside modal closes it properly.
```

### 43. Loading States
```
Navigate to Products page, verify loading skeletons/spinners appear while products are fetching, and disappear once data loads.
```

### 44. Form Field Validation
```
On registration page, try submitting with invalid email (no @), short password (<8 chars), and verify inline error messages appear for each field.
```

### 45. Image Lazy Loading
```
Go to Products page with many items, scroll down, and verify images load as they come into viewport (check network tab or visual loading).
```

---

## Advanced Testing Patterns

### 46. Multi-Browser Testing
```
Test the complete login flow (navigate to login, fill credentials, submit, verify redirect) to ensure it works consistently across different browsers.
```

### 47. Accessibility Verification
```
Navigate to home page, verify all images have alt text, buttons have accessible names, and headings are in proper hierarchical order (h1 → h2 → h3).
```

### 48. Performance - Page Load Time
```
Navigate to home page and measure that it loads within 3 seconds. Check that Largest Contentful Paint (LCP) occurs within 2.5 seconds.
```

### 49. API Error Handling
```
While on products page, simulate API failure (using network tab), and verify error message displays gracefully with retry option.
```

### 50. Cross-Device Synchronization
```
Login on desktop, add item to cart, then login on mobile (or mobile viewport), and verify cart items are synchronized across devices.
```

---

## Tips for Best Results

### Writing Effective Test Prompts

1. **Be Specific**: Instead of "test login", use "login with valid credentials and verify redirect to account page"

2. **Include Expected Outcomes**: Always mention what should happen after each action (e.g., "verify toast appears", "check URL changes to /account")

3. **One Flow Per Test**: Keep tests focused on a single user journey rather than multiple unrelated scenarios

4. **Use Natural Language**: Write as you would explain to a human tester - the AI understands context

5. **Mention Key Elements**: Reference specific button names, field labels, or text that should appear

### When Tests Fail

1. **Check Element Names**: The UI might use different text than expected (e.g., "Sign In" vs "Login")

2. **Timing Issues**: Add "wait for" steps if elements load dynamically

3. **State Dependencies**: Ensure prerequisites are met (e.g., "first register a user, then login")

4. **Selector Specificity**: If multiple elements match, be more specific in descriptions

### Self-Healing Triggers

After generating tests, you can test the self-healing capability by:
- Changing button text in source code
- Modifying CSS classes
- Restructuring HTML while keeping functionality
- Then re-running tests to see if locators are automatically fixed

---

## Need More Help?

- Run `AgenticQA: Doctor` to check setup
- Check Output panel → AgenticQA for detailed logs
- Review generated tests in `tests/generated/` folder
- Examine Tree View for step-by-step results
