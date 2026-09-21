// Decompile selected functions from the persistent Qianniu Ghidra project.
// @category Qianniu

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;

public class QnDecompileFunctions extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] addresses = getScriptArgs();
        if (addresses.length == 0) {
            printerr("Pass one or more function addresses.");
            return;
        }

        DecompInterface decompiler = new DecompInterface();
        decompiler.toggleCCode(true);
        decompiler.toggleSyntaxTree(true);
        if (!decompiler.openProgram(currentProgram)) {
            printerr("Decompiler could not open program: " + decompiler.getLastMessage());
            return;
        }

        println("PROGRAM " + currentProgram.getName());
        for (String rawAddress : addresses) {
            if (monitor.isCancelled()) {
                break;
            }
            Address address = toAddr(rawAddress);
            Function function = getFunctionContaining(address);
            if (function == null) {
                println("\nADDRESS " + address + " <no-function>");
                continue;
            }

            println("\nFUNCTION " + function.getName() + " @ " + function.getEntryPoint());
            println("SIGNATURE " + function.getSignature());
            println("REFERENCES_TO");
            ReferenceIterator references = currentProgram.getReferenceManager()
                .getReferencesTo(function.getEntryPoint());
            while (references.hasNext()) {
                Reference reference = references.next();
                Function caller = getFunctionContaining(reference.getFromAddress());
                println("  " + reference.getFromAddress() + " "
                    + (caller == null ? "<no-function>" : caller.getName() + " @ " + caller.getEntryPoint()));
            }

            DecompileResults result = decompiler.decompileFunction(function, 240, monitor);
            if (!result.decompileCompleted()) {
                println("DECOMPILE_FAILED " + result.getErrorMessage());
                continue;
            }
            println(result.getDecompiledFunction().getC());
        }
        decompiler.dispose();
    }
}
