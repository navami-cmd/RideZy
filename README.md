# RideZy

<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=500&size=20&pause=1100&color=3F6FA8&center=true&vCenter=true&width=520&lines=Pick+a+place.;Choose+a+driver.;Arrive+Zy." alt="Pick a place. Choose a driver. Arrive Zy.">
</p>

RideZy is a simple ride-booking web app. Enter a pickup and drop, choose a ride, and follow your driver to you on the map. Fares are worked out from the real route, and you can schedule rides, save places and split the cost with friends.

It has a rider app, a driver app and a small backend. Riders and drivers sign in with their mobile number, and payments run through Razorpay.

## Stack

![HTML5](https://img.shields.io/badge/HTML5-0b1f3f?style=flat-square&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-3f6fa8?style=flat-square&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-0b1f3f?style=flat-square&logo=javascript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-3f6fa8?style=flat-square&logo=nodedotjs&logoColor=white)
![Leaflet](https://img.shields.io/badge/Leaflet-0b1f3f?style=flat-square&logo=leaflet&logoColor=white)

- Frontend: vanilla HTML, CSS and JavaScript, with [Leaflet](https://leafletjs.com) for the map
- Backend: Node.js using only built-in modules (no dependencies), with server-sent events for live updates
- Payments: Razorpay. SMS codes: Twilio (optional)
- Map data: Esri / OpenStreetMap tiles, Nominatim (search), OSRM (routing), Open-Meteo (weather)

## Run locally

Requires Node.js 18 or newer.

```bash
node server/server.js
```

Then open:

- Rider app: http://localhost:3000
- Driver app: http://localhost:3000/driver.html

Sign-in codes are printed in the terminal until SMS is configured.

Opening `index.html` on its own (for example with Live Server) still works. It runs in demo mode with simulated drivers.

## Configuration

Copy `.env.example` to `.env` and add the keys you need. Everything is optional.

- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` enable real online payments. Without them, payments run in demo mode.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` send real SMS codes.

Never commit `.env`. Secret keys belong on the server only.

## Project structure

```
index.html        rider app
driver.html       driver app
server/server.js  API, live updates and static hosting
images/           logo and background
.env.example      configuration template
```

## Status

Working: sign-in with OTP, ride requests, driver dispatch, live driver tracking, OTP trip start, online and cash payments, ratings.

Not yet built: driver document verification, driver payouts, push notifications, a production database.
