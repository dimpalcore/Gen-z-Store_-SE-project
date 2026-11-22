# 🛍️ Gen-Z-Store

A full-stack e-commerce product listing system. Customers can browse products, add them to a cart, sign up / log in and place orders. Admins can manage the product catalogue.

## Features
- Product listing with search, category filter, price slider and sorting
- Product details: emoji, rating, description and colours
- Shopping cart (quantity controls, saved in the browser)
- User signup and login (passwords are hashed with scrypt)
- Orders saved in a SQLite database and linked to the user
- "My Orders" page for customers; admins see all orders
- Admin-only add / delete product
- REST API built with Node.js built-in modules (no npm packages)

## Tech Stack
- **Frontend:** HTML, CSS, JavaScript
- **Backend:** Node.js (http module)
- **Database:** SQLite (`node:sqlite`)

## Getting Started
1. Install [Node.js](https://nodejs.org) (version 22.13 or newer)
2. Clone the repository:
