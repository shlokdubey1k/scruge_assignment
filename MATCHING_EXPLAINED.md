# 🧸 How Product Matching Works
### *Explained Like You're 5 (With Pictures & Flowcharts!)*

---

## 🌟 The Big Idea: The Smart Toy Detective

Imagine you found a toy robot on **Amazon** that you really want. But your mom says: 
> *"Let's check if the toy store down the street (**Flipkart**, **Croma**, or **Myntra**) has the EXACT same robot, and if it's sitting on the shelf ready to buy!"*

Instead of clicking and typing on 10 different websites yourself, our app acts like a **super-fast detective** 🕵️‍♂️ who does it all for you in a few seconds!

---

## 🗺️ How It Works: The Grand Map

```mermaid
flowchart TD
    Start(["🛒 You paste an Amazon Link"]) --> ReadAmazon["📖 Step 1: Read the Amazon Page<br><i>What is the brand, model, and specs?</i>"]
    
    ReadAmazon --> CategorySplit{"📦 Which Category is it?"}
    
    CategorySplit -->|"📱 Smartphone"| ShopTech["Search Flipkart & Croma<br><i>Check: RAM & Storage</i>"]
    CategorySplit -->|"📺 Television"| ShopTV["Search Flipkart & Croma<br><i>Check: Screen Size</i>"]
    CategorySplit -->|"👟 Sneakers"| ShopFashion1["Search Flipkart & Myntra<br><i>Check: Colourway</i>"]
    CategorySplit -->|"👕 T-shirt / Clothing"| ShopFashion2["Search Flipkart & Myntra<br><i>Check: Colourway</i>"]
    
    ShopTech --> AIDetective["🧠 Step 2: The AI Detective<br><i>Compares all search candidates</i>"]
    ShopTV --> AIDetective
    ShopFashion1 --> AIDetective
    ShopFashion2 --> AIDetective
    
    AIDetective --> FoundMatch{"Did we find the<br>EXACT same product?"}
    
    FoundMatch -->|"No"| BlackBadge["⚫ <b>Not Listed</b><br>Store does not sell this product"]
    FoundMatch -->|"Yes"| LiveStock["🔍 Step 3: Live Shelf Check<br><i>Check Buy Now vs Notify Me button</i>"]
    
    LiveStock --> InStock{"Can you buy it<br>right now?"}
    InStock -->|"Yes (Buy Now)"| GreenBadge["🟢 <b>In Stock</b><br>Direct buy link ready!"]
    InStock -->|"No (Notify Me / Sold Out)"| YellowBadge["🟡 <b>Out of Stock</b><br>Found it, but currently unavailable"]
```

---

## 🔍 Step 1: Reading the Amazon Page

When you give us an Amazon link, we open the page and ask our AI (Google Gemini):
> *"Hey detective, what are we looking at? Tell me the brand, model name, and its superpowers!"*

```mermaid
flowchart LR
    Link["Amazon Link<br>amazon.in/dp/..."] --> Scraper["Fetcher & ASIN Resolver"]
    Scraper --> Gemini["Gemini AI Extraction"]
    Gemini --> Specs["🏷️ Clean Product Identity:<br>• Brand & Model<br>• Category<br>• Critical Specs"]
```

Depending on the product, we zoom in on the rules:
* 📱 **Phone**: How much Brain (**RAM**) and Pocket Space (**Storage**) does it have?
* 📺 **Television**: How big is the glass screen (**Inches**)?
* 👟 **Sneakers & Clothes**: What **Colour** is it?

---

## 🏬 Step 2: Going to the Right Stores

Not all stores sell everything! You wouldn't buy a pair of running shoes at an electronics store, right?

Our app automatically picks the right stores for each category:

```mermaid
graph TD
    subgraph Electronics ["⚡ Electronics Stores"]
        FK1["🛒 Flipkart"]
        CR["🟢 Croma"]
    end

    subgraph Fashion ["👗 Fashion Stores"]
        FK2["🛒 Flipkart"]
        MY["👗 Myntra"]
    end

    Phone["📱 Smartphone"] --> FK1 & CR
    TV["📺 Television"] --> FK1 & CR
    Shoes["👟 Sneakers"] --> FK2 & MY
    Clothes["👕 T-shirts / Polos"] --> FK2 & MY
```

---

## 🕵️ Step 3: Comparing Like a Detective

This is the hardest part. Just having a similar name is **not enough**! 

If you want a **Red 128GB iPhone**, and a store offers a **Blue 256GB iPhone**, they are **NOT** the same!

```mermaid
flowchart TD
    subgraph DetectiveRules ["Strict Spec Matching Rules"]
        direction TB
        R1["📱 Phones: RAM + Storage must match!<br><i>8GB + 128GB ≠ 8GB + 256GB</i>"]
        R2["📺 TVs: Screen size must match!<br><i>55 inch ≠ 65 inch</i>"]
        R3["👟 Clothes & Shoes: Colour must match!<br><i>White/Black ≠ All Black</i>"]
    end

    AmazonItem["Target Product<br>(from Amazon)"] --> AI["AI Comparison Engine"]
    StoreCandidates["Store Candidates<br>(Flipkart / Croma / Myntra)"] --> AI
    DetectiveRules -.-> AI
    AI --> Decision["🎯 Exact Match OR Reject"]
```

---

## 📦 Step 4: The Live Shelf Check (Stock Status)

Sometimes a store listed a product a year ago, but today the shelves are empty!

We don't want to tell you *"It's available!"* only for you to click and see a sad *"Sold Out"* screen. So our backend visits the matched product page right before answering:

```mermaid
flowchart LR
    Matched["Matched Product Page"] --> CheckButtons{"Inspect Checkout Buttons"}
    CheckButtons -->|"Has 'Buy Now' / 'Add to Cart'"| InStock["🟢 <b>In Stock</b><br>You can buy it right now!"]
    CheckButtons -->|"Has 'Notify Me' / 'Sold Out'"| OutOfStock["🟡 <b>Out of Stock</b><br>Found the item, but shelves are empty!"]
    CheckButtons -->|"No Product Page Found"| NotListed["⚫ <b>Not Listed</b><br>Store doesn't sell this model"]
```

---

## 📋 What You See on Screen

For each store, you get one of three crystal-clear badges:

| Badge | Meaning | What Happens When You Click |
|---|---|---|
| 🟢 **In Stock** | The exact same item is on the shelf and ready to purchase! | Takes you straight to the checkout/product page to buy. |
| 🟡 **Out of Stock** | Found the exact same item, but it is currently sold out or has a "Notify Me" button. | Takes you to the product page so you can click "Notify Me" or track restocks. |
| ⚫ **Not Listed** | This store doesn't sell this specific model or spec configuration. | Keeps you from wasting time searching a store that doesn't have it. |

---

## 💡 Why This Is Smart

Every shopping website formats their names and HTML differently:
* Flipkart writes: `SONY Bravia 2 138.8 cm (55 inch) Ultra HD (4K)`
* Amazon writes: `Sony Bravia 55 inches 4K Ultra HD Smart LED Google TV`
* Croma writes: `Sony Bravia 2 II 140 cm (55 Inch) 4K Ultra HD`

Traditional scraper code breaks whenever a website changes a single button or CSS class name. By combining **targeted e-commerce searches** with **Gemini AI reasoning** and **live button verification**, our system:
1. Understands product variants like a human expert.
2. Respects strict hardware specifications (RAM, storage, screen size, colour).
3. Always gives real, verified stock status!

---

*Built for Scruge — Founding Backend Engineer Assignment*  
*Architecture: Zero external npm dependencies · Node.js HTTP/HTTPS · Google Gemini 2.5/3.5 · Vanilla HTML5/CSS3*
