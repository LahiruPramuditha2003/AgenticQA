import { test, expect } from '@playwright/test';

/**
 * SAMPLE REFERENCE TEST FILE
 * =========================
 *
 * This file contains working Playwright test examples for the TechStore demo app.
 * These tests demonstrate proper locator strategies and test patterns that AgenticQA
 * should generate when given natural language prompts from TEST_TEMPLATES.md.
 *
 * Key patterns demonstrated:
 * - data-testid attributes (preferred for stability)
 * - Role-based locators (semantic and accessible)
 * - Text-based locators (when no testids available)
 * - Proper wait strategies and assertions
 * - Realistic user flows matching TEST_TEMPLATES.md scenarios
 */

test.describe('TechStore E-commerce Tests', () => {

  // ============================================================================
  // HOMEPAGE & NAVIGATION TESTS
  // ============================================================================

  test('Navigate to home page and verify hero section', async ({ page }) => {
    // Navigate to home page
    await page.goto('http://localhost:5173');

    // Wait for page to load completely
    await page.waitForLoadState('networkidle');

    // Verify hero section elements (using data-testid - most stable)
    await expect(page.getByTestId('hero-title')).toBeVisible();
    await expect(page.getByTestId('hero-subtitle')).toBeVisible();
    await expect(page.getByTestId('hero-shop-now')).toBeVisible();
    await expect(page.getByTestId('hero-new-arrivals')).toBeVisible();

    // Verify hero title text content
    await expect(page.getByTestId('hero-title')).toContainText('Welcome to TechStore');
  });

  test('Verify navigation bar contains required links', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForLoadState('networkidle');

    // Check navbar logo
    await expect(page.getByTestId('navbar-logo')).toBeVisible();

    // Check search functionality
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page.getByTestId('search-button')).toBeVisible();

    // Check navigation links (using testids for stability)
    await expect(page.getByTestId('nav-products')).toBeVisible();
    await expect(page.getByTestId('nav-cart')).toBeVisible();
    await expect(page.getByTestId('nav-login')).toBeVisible();

    // Verify link text content
    await expect(page.getByTestId('nav-products')).toContainText('Products');
    await expect(page.getByTestId('nav-login')).toContainText('Login');
  });

  // ============================================================================
  // PRODUCT BROWSING TESTS
  // ============================================================================

  test('Browse products page and verify basic structure', async ({ page }) => {
    await page.goto('http://localhost:5173/products');
    await page.waitForLoadState('networkidle');

    // Verify page title
    await expect(page.getByTestId('products-title')).toBeVisible();
    await expect(page.getByTestId('products-title')).toContainText('All Products');

    // Verify products grid exists
    await expect(page.getByTestId('products-grid')).toBeVisible();

    // Verify filter sidebar
    await expect(page.getByTestId('filters-sidebar')).toBeVisible();

    // Check for product count display
    await expect(page.getByTestId('products-count')).toBeVisible();
  });

  test('Filter products by category', async ({ page }) => {
    await page.goto('http://localhost:5173/products');
    await page.waitForLoadState('networkidle');

    // Click on Smartphones category filter
    await page.getByTestId('filter-category-smartphones').click();

    // Wait for URL to update
    await page.waitForURL('**/products?category=Smartphones');

    // Verify URL contains category filter
    await expect(page).toHaveURL(/.*category=Smartphones/);

    // Verify page shows filtered results
    await expect(page.getByTestId('products-title')).toContainText('Smartphones');
  });

  test('Search for products', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForLoadState('networkidle');

    // Use search input
    await page.getByTestId('search-input').fill('laptop');
    await page.getByTestId('search-button').click();

    // Wait for navigation to search results
    await page.waitForURL('**/products?search=laptop');

    // Verify search results page
    await expect(page).toHaveURL(/.*search=laptop/);
    await expect(page.getByTestId('products-title')).toContainText('laptop');
  });

  // ============================================================================
  // PRODUCT DETAIL TESTS
  // ============================================================================

  test('View product details', async ({ page }) => {
    // Start from products page
    await page.goto('http://localhost:5173/products');
    await page.waitForLoadState('networkidle');

    // Click on first product (this would navigate to product detail page)
    // Note: In real scenario, we'd need to know the product ID or use a specific product
    await page.locator('[data-testid^="product-card-"]').first().click();

    // Wait for navigation to product page
    await page.waitForURL('**/products/*');

    // Verify product detail elements
    await expect(page.getByTestId('product-title')).toBeVisible();
    await expect(page.getByTestId('product-price')).toBeVisible();
    await expect(page.getByTestId('product-description')).toBeVisible();
    await expect(page.getByTestId('add-to-cart-btn')).toBeVisible();
  });

  // ============================================================================
  // SHOPPING CART TESTS
  // ============================================================================

  test('Add product to cart from product page', async ({ page }) => {
    // Navigate to a product page (assuming we know a product ID)
    await page.goto('http://localhost:5173/products/1'); // Example product ID
    await page.waitForLoadState('networkidle');

    // Click add to cart button
    await page.getByTestId('add-to-cart-btn').click();

    // Verify success toast appears
    await expect(page.getByTestId('toast-success')).toBeVisible();
    await expect(page.getByTestId('toast-success')).toContainText('added to cart');

    // Verify cart badge shows 1 item
    await expect(page.getByTestId('cart-badge')).toContainText('1');
  });

  test('View cart and verify contents', async ({ page }) => {
    // Assuming we have items in cart, navigate to cart
    await page.goto('http://localhost:5173/cart');
    await page.waitForLoadState('networkidle');

    // Verify cart page elements
    await expect(page.getByTestId('cart-title')).toBeVisible();
    await expect(page.getByTestId('cart-items')).toBeVisible();

    // Check for cart total
    await expect(page.getByTestId('cart-total')).toBeVisible();

    // Verify checkout button
    await expect(page.getByTestId('checkout-btn')).toBeVisible();
  });

  // ============================================================================
  // CHECKOUT FLOW TESTS
  // ============================================================================

  test('Complete checkout flow - guest user', async ({ page }) => {
    // Start with items in cart
    await page.goto('http://localhost:5173/cart');
    await page.waitForLoadState('networkidle');

    // Click checkout
    await page.getByTestId('checkout-btn').click();

    // Wait for checkout page
    await page.waitForURL('**/checkout');

    // Fill shipping information
    await page.getByTestId('shipping-first-name').fill('John');
    await page.getByTestId('shipping-last-name').fill('Doe');
    await page.getByTestId('shipping-email').fill('john.doe@example.com');
    await page.getByTestId('shipping-address').fill('123 Main St');
    await page.getByTestId('shipping-city').fill('New York');
    await page.getByTestId('shipping-zip').fill('10001');

    // Click continue to payment
    await page.getByTestId('continue-to-payment').click();

    // Fill payment information
    await page.getByTestId('payment-card-number').fill('4111111111111111');
    await page.getByTestId('payment-expiry').fill('12/25');
    await page.getByTestId('payment-cvc').fill('123');

    // Complete order
    await page.getByTestId('complete-order-btn').click();

    // Verify order confirmation
    await page.waitForURL('**/order-confirmation');
    await expect(page.getByTestId('order-confirmation')).toBeVisible();
    await expect(page.getByTestId('order-number')).toBeVisible();
  });

  // ============================================================================
  // USER AUTHENTICATION TESTS
  // ============================================================================

  test('User login flow', async ({ page }) => {
    await page.goto('http://localhost:5173/auth/login');
    await page.waitForLoadState('networkidle');

    // Fill login form
    await page.getByTestId('login-email').fill('customer@example.com');
    await page.getByTestId('login-password').fill('password123');
    await page.getByTestId('login-submit').click();

    // Verify redirect to account page
    await page.waitForURL('**/account');
    await expect(page.getByTestId('account-welcome')).toContainText('Welcome');
  });

  test('User registration', async ({ page }) => {
    await page.goto('http://localhost:5173/auth/register');
    await page.waitForLoadState('networkidle');

    // Fill registration form
    await page.getByTestId('register-first-name').fill('Test');
    await page.getByTestId('register-last-name').fill('User');
    await page.getByTestId('register-email').fill('test.user@example.com');
    await page.getByTestId('register-password').fill('SecurePass123!');
    await page.getByTestId('register-confirm-password').fill('SecurePass123!');

    // Submit registration
    await page.getByTestId('register-submit').click();

    // Verify success message or redirect
    await expect(page.getByTestId('registration-success')).toBeVisible();
  });

  // ============================================================================
  // ADMIN DASHBOARD TESTS
  // ============================================================================

  test('Admin login and dashboard access', async ({ page }) => {
    await page.goto('http://localhost:5173/auth/login');
    await page.waitForLoadState('networkidle');

    // Login as admin
    await page.getByTestId('login-email').fill('admin@techstore.com');
    await page.getByTestId('login-password').fill('admin123');
    await page.getByTestId('login-submit').click();

    // Navigate to admin
    await page.goto('http://localhost:5173/admin');
    await page.waitForLoadState('networkidle');

    // Verify admin dashboard
    await expect(page.getByTestId('admin-dashboard')).toBeVisible();
    await expect(page.getByTestId('admin-products-tab')).toBeVisible();
    await expect(page.getByTestId('admin-orders-tab')).toBeVisible();
  });

  // ============================================================================
  // ERROR HANDLING & EDGE CASES
  // ============================================================================

  test('Handle invalid route - 404 page', async ({ page }) => {
    await page.goto('http://localhost:5173/nonexistent-page');
    await page.waitForLoadState('networkidle');

    // Verify 404 page or redirect to home
    await expect(page.getByTestId('page-not-found')).toBeVisible();
  });

  test('Search with no results', async ({ page }) => {
    await page.goto('http://localhost:5173');
    await page.waitForLoadState('networkidle');

    // Search for non-existent product
    await page.getByTestId('search-input').fill('xyz123nonexistent');
    await page.getByTestId('search-button').click();

    // Wait for results
    await page.waitForURL('**/products?search=xyz123nonexistent');

    // Verify no results message
    await expect(page.getByTestId('no-results')).toBeVisible();
    await expect(page.getByTestId('no-results')).toContainText('No products found');
  });

  test('Empty cart checkout redirect', async ({ page }) => {
    // Navigate directly to checkout with empty cart
    await page.goto('http://localhost:5173/checkout');
    await page.waitForLoadState('networkidle');

    // Verify redirect to cart page
    await page.waitForURL('**/cart');
    await expect(page.getByTestId('empty-cart-message')).toBeVisible();
  });

});

/**
 * NOTES FOR AGENTICQA TEST GENERATION:
 *
 * 1. Prefer data-testid attributes for maximum stability
 * 2. Use semantic locators (role + accessible name) as fallback
 * 3. Include proper wait strategies (waitForLoad, waitForURL)
 * 4. Test realistic user flows, not just element presence
 * 5. Handle navigation and state changes appropriately
 * 6. Include both positive and negative test scenarios
 * 7. Verify user feedback (toasts, messages, redirects)
 *
 * These patterns should be generated from TEST_TEMPLATES.md prompts.
 */
