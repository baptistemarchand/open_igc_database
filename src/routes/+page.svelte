<h1>Open IGC Database</h1>
<p class="lead">
	A free, open, public database of paragliding flights (IGC tracklogs), built for research.
	Upload your flights and browse everyone's.
</p>

<div class="cards">
	<a class="card" href="/browse">
		<h2>Browse flights &rarr;</h2>
		<p>Search by pilot, date, and glider. Sort by duration or altitude.</p>
	</a>
	<a class="card" href="/upload">
		<h2>Upload flights &rarr;</h2>
		<p>Add one or many IGC files to the public database.</p>
	</a>
</div>

<style>
	.lead {
		font-size: 1.1rem;
		color: #444;
		max-width: 40rem;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
		gap: 1rem;
		margin-top: 1.5rem;
	}
	.card {
		display: block;
		padding: 1.25rem;
		border: 1px solid #e5e5e5;
		border-radius: 10px;
		background: #fff;
		text-decoration: none;
		color: inherit;
	}
	.card:hover {
		border-color: #0064c8;
	}
	.card h2 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
		color: #0064c8;
	}
	.card p {
		margin: 0;
		color: #666;
		font-size: 0.95rem;
	}
</style>
