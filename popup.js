async function findModels() {
    const response = await fetch("http://localhost:11434/api/tags");
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);  // fixed template literal
    }
    const data = await response.json();
    return data.models;
}

async function populateModelDropdown() {
    const dropdown = document.getElementById("modelDropdown");
    try {
        const models = await findModels();
        dropdown.innerHTML = ""; // clear "Loading..."

        if (!models || models.length === 0) {
            dropdown.innerHTML = "<option disabled>No local models found</option>";
            return;
        }

        models.forEach((model) => {
            const option = document.createElement("option");
            option.value = model.name;
            option.innerText = model.name;
            dropdown.appendChild(option);
        });

    } catch (err) {
        dropdown.innerHTML = "<option disabled>Ollama not running</option>";
        console.error("Failed to fetch models:", err);
    }
}

populateModelDropdown();

document.addEventListener('DOMContentLoaded', () => {
    // Load initial values
    chrome.storage.local.get(['tokensSaved', 'localQueries', 'cloudQueries'], (res) => {
        document.getElementById("tokensSaved").innerText = res.tokensSaved || 0;
        document.getElementById("localQueries").innerText = res.localQueries || 0;
        document.getElementById("cloudQueries").innerText = res.cloudQueries || 0;
        updateEfficiency(res.localQueries || 0, res.cloudQueries || 0);
    });

    // Listen for live updates while popup is open
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace !== 'local') return;

        if (changes.tokensSaved)
            document.getElementById("tokensSaved").innerText = changes.tokensSaved.newValue;

        if (changes.localQueries)
            document.getElementById("localQueries").innerText = changes.localQueries.newValue;

        if (changes.cloudQueries)
            document.getElementById("cloudQueries").innerText = changes.cloudQueries.newValue;

        // Recalculate efficiency after any change
        chrome.storage.local.get(['localQueries', 'cloudQueries'], (res) => {
            updateEfficiency(res.localQueries || 0, res.cloudQueries || 0);
        });
    });

    // Reset button
    document.querySelector(".reset-btn").addEventListener("click", () => {
        chrome.storage.local.set({ tokensSaved: 0, localQueries: 0, cloudQueries: 0 }, () => {
            document.getElementById("tokensSaved").innerText = 0;
            document.getElementById("localQueries").innerText = 0;
            document.getElementById("cloudQueries").innerText = 0;
            document.getElementById("efficiencyScore").innerText = "--";
        });
    });
});

