export function buildWebviewBridgeScript(options: { supportPaperId?: boolean; supportLoadState?: boolean } = {}): string {
    const loadStateHandler = options.supportLoadState
        ? `else if (message.command === 'load_state') {
                if (window.loadState) window.loadState(message.state);
            }`
        : '';
    const paperIdInject = options.supportPaperId ? ', message.paperId' : '';

    return `
        const vscode = acquireVsCodeApi();
        window.vscode = vscode;
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'inject_context_and_search') {
                performSearch(message.query, message.modelId${paperIdInject});
            }
            ${loadStateHandler}
            else if (message.command === 'fill_query') {
                var input = document.getElementById('queryInput');
                if (input) input.value = message.query;
            }
            else if (message.command === 'display_result') {
                if (window.loadState) window.loadState({ query: message.query, data: message.data });
            }
            else if (message.command === 'trigger_new_conversation') {
                if (window.startNewConversation) window.startNewConversation();
            }
            else if (message.command === 'request_save_results') {
                if (window.saveResults) window.saveResults();
            }
            else if (message.command === 'save_results_done') {
                if (window.addThought) window.addThought('Results saved.', 'success');
            }
            else if (message.command === 'set_models') {
                const select = document.getElementById('modelSelect');
                if (select && message.models) {
                    select.innerHTML = '<option value="">Auto (VS Code Default)</option>';
                    message.models.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m.id;
                        opt.textContent = m.name + ' (' + m.family + ')';
                        select.appendChild(opt);
                    });
                    if (message.lastModelId) {
                        select.value = message.lastModelId;
                    }
                }
            }
            else if (message.command === 'execution_started') {
                const pod = document.getElementById('terminalPod');
                if (pod) {
                    pod.classList.remove('hidden');
                    document.getElementById('terminalContent').innerText = 'Executing ' + message.language + ' code...\\n';
                }
            }
            else if (message.command === 'execution_result') {
                const pod = document.getElementById('terminalPod');
                if (pod) {
                    let text = document.getElementById('terminalContent').innerText;
                    if (message.error) {
                        text += '\\n[ERROR]\\n' + message.error;
                    } else {
                        if (message.stdout) text += '\\n[STDOUT]\\n' + message.stdout;
                        if (message.stderr) text += '\\n[STDERR]\\n' + message.stderr;
                    }
                    document.getElementById('terminalContent').innerText = text;
                }
            }
            else if (message.command === 'deep_research_chunk') {
                if (window.handleDeepResearchChunk) window.handleDeepResearchChunk(message.text);
            }
            else if (message.command === 'deep_research_done') {
                if (window.handleDeepResearchDone) window.handleDeepResearchDone(message.text, message.interactionId);
            }
            else if (message.command === 'deep_research_status') {
                if (window.handleDeepResearchStatus) window.handleDeepResearchStatus(message.status);
            }
            else if (message.command === 'regenerate_simulation_done') {
                if (window.handleRegenerateSimulation) window.handleRegenerateSimulation(message.text);
            }
            else if (message.command === 'regenerate_simulation_error') {
                if (window.handleRegenerateSimulationError) window.handleRegenerateSimulationError(message.text);
            }
            else if (message.command === 'fix_simulation_done') {
                if (window.handleSimulationFix) window.handleSimulationFix(message.text);
            }
            else if (message.command === 'fix_simulation_error') {
                if (window.handleSimulationFixError) window.handleSimulationFixError(message.text);
            }
            else if (message.command === 'generate_simulation_done') {
                if (window.handleGenerateSimulationDone) window.handleGenerateSimulationDone(message.text);
            }
            else if (message.command === 'generate_simulation_error') {
                if (window.handleGenerateSimulationError) window.handleGenerateSimulationError(message.text);
            }
            else if (message.command === 'enhance_done') {
                if (window.handleEnhanceDone) window.handleEnhanceDone(message.text);
            }
            else if (message.command === 'enhance_error') {
                if (window.handleEnhanceError) window.handleEnhanceError(message.text);
            }
            else if (message.command === 'repair_animation_done') {
                if (window.handleAnimationRepairDone) window.handleAnimationRepairDone(message.text);
            }
            else if (message.command === 'repair_animation_error') {
                if (window.handleAnimationRepairError) window.handleAnimationRepairError(message.text);
            }
            else if (message.command === 'narrate_audio_ready') {
                if (window.handleNarrationAudio) window.handleNarrationAudio(message.audioBase64, message.requestId);
            }
            else if (message.command === 'narrate_error') {
                if (window.handleNarrationError) window.handleNarrationError(message.text, message.requestId);
            }
            else if (message.command === 'narration_settings') {
                if (window.handleNarrationSettings) window.handleNarrationSettings(message.settings, message.voices);
            }
            else if (message.command === 'dossier_created') {
                if (window.handleDossierCreated) window.handleDossierCreated(message.dossier);
            }
            else if (message.command === 'dossier_loaded') {
                if (window.handleDossierLoaded) window.handleDossierLoaded(message.dossier);
            }
            else if (message.command === 'dossier_list') {
                if (window.handleDossierList) window.handleDossierList(message.items);
            }
            else if (message.command === 'dossier_chunk') {
                if (window.handleDossierChunk) window.handleDossierChunk(message.text);
            }
            else if (message.command === 'dossier_error') {
                if (window.handleDossierError) window.handleDossierError(message.text);
            }
            else if (message.command === 'deep_run_started') {
                if (window.handleDeepRunStarted) window.handleDeepRunStarted(message.id);
            }
            else if (message.command === 'deep_run_plan') {
                if (window.handleDeepRunPlan) window.handleDeepRunPlan(message.id, message.subQuestions);
            }
            else if (message.command === 'deep_run_stage') {
                if (window.handleDeepRunStage) window.handleDeepRunStage(message.id, message.stage);
            }
            else if (message.command === 'deep_run_done') {
                if (window.handleDeepRunDone) window.handleDeepRunDone(message.id, message.result);
            }
            else if (message.command === 'deep_run_error') {
                if (window.handleDeepRunError) window.handleDeepRunError(message.text);
            }
            else if (message.command === 'deep_run_list') {
                if (window.handleDeepRunList) window.handleDeepRunList(message.items);
            }
            else if (message.command === 'deep_run_loaded') {
                if (window.handleDeepRunLoaded) window.handleDeepRunLoaded(message.run);
            }
            else if (message.command === 'providers_list') {
                if (window.handleProvidersList) window.handleProvidersList(message.providers);
            }
            else if (message.command === 'set_recent_activity') {
                var items = message.items || [];
                var rail = document.getElementById('recentRail');
                var pills = document.getElementById('recentPills');
                if (rail && pills && items.length) {
                    rail.style.display = 'block';
                    var iconMap = { dossier: 'fa-book', deep_run: 'fa-flask-vial', course: 'fa-graduation-cap', agenda: 'fa-calendar-check', search: 'fa-clock' };
                    function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
                    var html = '';
                    items.forEach(function(item) {
                        var icon = iconMap[item.type] || 'fa-circle';
                        var label = esc((item.title || '').substring(0, 40));
                        html += '<div class="recent-pill" title="' + (item.title || '').replace(/"/g, '&quot;').replace(/</g, '&lt;') + '"><i class="fas ' + icon + '" style="font-size:9px;"></i> ' + label + '</div>';
                    });
                    pills.innerHTML = html;
                }
            }
        });
        window.addEventListener('load', () => vscode.postMessage({ command: 'webview_ready' }));
    `;
}

export function buildCallAgentScript(options: { supportPaperId?: boolean } = {}): string {
    const paperIdParam = options.supportPaperId ? ', paperId' : '';
    const paperIdPost = options.supportPaperId ? ', paperId: paperId' : '';

    return `
        var isSearchInProgress = false;

        async function callAgent(query, modelId${paperIdParam}) {
            return new Promise((resolve, reject) => {
                vscode.postMessage({ command: 'search', query: query, modelId: modelId${paperIdPost} });
                let partialTimer = null;
                let latestChunk = '';
                function tryPartialRender() {
                    try {
                        let clean = latestChunk.replace(/^\\s*\\x60\\x60\\x60(json)?/i, '').replace(/\\x60\\x60\\x60\\s*$/, '').trim();
                        const endings = ["", "}", "\\"}", "]}", "\\"]}", "}}", "\\"}}", "\\"]}}"];
                        for(let ending of endings) {
                            try {
                                const partial = JSON.parse(clean + ending);
                                window.renderPartialResults(partial);
                                break;
                            } catch(e) {}
                        }
                    } catch(e) {}
                }
                const handler = function(event) {
                    const message = event.data;
                    if (message.command === 'search_chunk') {
                        latestChunk = message.text;
                        if (!partialTimer) {
                            partialTimer = setTimeout(() => { partialTimer = null; tryPartialRender(); }, 300);
                        }
                    }
                    else if (message.command === 'search_done') {
                        if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
                        window.removeEventListener('message', handler);
                        try {
                            resolve(JSON.parse(message.text));
                        } catch(e) {
                            reject(new Error("Failed to parse JSON response from LLM: " + message.text));
                        }
                    } else if (message.command === 'error') {
                        if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
                        window.removeEventListener('message', handler);
                        reject(new Error(message.text));
                    } else if (message.command === 'search_cancelled') {
                        if (partialTimer) { clearTimeout(partialTimer); partialTimer = null; }
                        window.removeEventListener('message', handler);
                        reject(new Error('CANCELLED'));
                    }
                };
                window.addEventListener('message', handler);
            });
        }
    `;
}
