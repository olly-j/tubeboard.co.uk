/* TubeBoard website — 24 July 2026 release */
(function () {
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("primary-nav");

  if (toggle && nav) {
    toggle.hidden = false;
    document.body.classList.add("has-nav-toggle");

    var closeNav = function () {
      toggle.setAttribute("aria-expanded", "false");
      document.body.classList.remove("nav-open");
    };

    toggle.addEventListener("click", function () {
      var isOpen = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!isOpen));
      document.body.classList.toggle("nav-open", !isOpen);
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) closeNav();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
        closeNav();
        toggle.focus();
      }
    });
  }

  var year = String(new Date().getFullYear());
  document.querySelectorAll("[data-current-year]").forEach(function (node) {
    node.textContent = year;
  });
})();
