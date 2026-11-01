# RideZy

<p align="center">
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=500&size=20&pause=1100&color=3F6FA8&center=true&vCenter=true&width=520&lines=Pick+a+place.;Choose+a+driver.;Arrive+Zy." alt="Pick a place. Choose a driver. Arrive Zy.">
</p>

RideZy is a simple ride-booking web app. Enter a pickup and drop, choose a ride and a driver, and follow them to you on the map. Fares are worked out from the real route, and you can schedule rides, save places and split the cost with friends.

It has a rider app, a driver app and a small Node.js backend, with no framework and no build step.

## Stack

![HTML5](https://img.shields.io/badge/HTML5-0b1f3f?style=flat-square&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-3f6fa8?style=flat-square&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-0b1f3f?style=flat-square&logo=javascript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-3f6fa8?style=flat-square&logo=nodedotjs&logoColor=white)
![Leaflet](https://img.shields.io/badge/Leaflet-0b1f3f?style=flat-square&logo=leaflet&logoColor=white)

- Vanilla HTML, CSS and JavaScript
- Node.js backend using only built-in modules
- [Leaflet](https://leafletjs.com) for the map
- Esri / OpenStreetMap tiles, Nominatim (search), OSRM (routing), Open-Meteo (weather)

No API keys are needed to run it. Razorpay and Twilio keys are optional, for real payments and SMS codes.

## Run locally

1. Clone or download this repository.
2. Run `node server/server.js` (Node.js 18 or newer).
3. Open http://localhost:3000 for riders and http://localhost:3000/driver.html for drivers.

An internet connection is needed for the map, place search and fonts. Opening `index.html` with Live Server also works, in demo mode with simulated drivers.

## Notes

Payments run in demo mode until Razorpay keys are added to a `.env` file (see `.env.example`). SOS is a demo.
