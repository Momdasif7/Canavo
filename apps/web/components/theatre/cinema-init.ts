/**
 * Cinema mode for the guest seat pages (/s/<screen>, /t/<seat>): a near-black, dim, quiet look
 * (html.cinema in globals.css) whatever the phone's light / dark setting.
 *
 * Printed seat codes carry `?c=1`, and /s/ is always a screen, so the inline script below turns
 * cinema mode on before the first paint (no white flash in a dark hall). A seat opened without
 * the flag switches as soon as the page knows it is a seat.
 */
export const cinemaInitScript = `(function(){try{var l=location;if(/^\\/s\\//.test(l.pathname)||(/^\\/t\\//.test(l.pathname)&&/[?&]c=1(&|$)/.test(l.search))){document.documentElement.classList.add("cinema","dark")}}catch(e){}})()`;

